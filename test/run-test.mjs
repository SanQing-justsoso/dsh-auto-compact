/**
 * Offline test for dsh-auto-compact: a fake cordis context drives the plugin's
 * listeners against a fake compaction engine, token meter, and LLM service.
 * Covers policy sync, both compaction triggers, guards, runtime re-sync, and
 * the /autocompact command. No network, no real DSH boot.
 *
 * Run from the package root:  node test/run-test.mjs
 * Requires the @deepseek-ai/* peer packages to resolve (a node_modules symlink
 * to the app runtime's node_modules is enough for development).
 */
import assert from "node:assert/strict";
import { apply, resolveSettings } from "../lib/index.js";

/* ---------------------------------------------------------------- fake ctx */

function cell(value) {
	return { get: () => value, set: (next) => { value = next; } };
}

function makeConfig(overrides = {}) {
	const values = {
		enabled: true,
		thresholdRatio: 0.4,
		retainRatio: undefined,
		retainTokens: undefined,
		headroomTokens: undefined,
		cooldownSeconds: 30,
		...overrides
	};
	const config = {};
	// Volatile scalars arrive as cells; the non-volatile array arrives plain,
	// exactly as the loader hands them to apply().
	for (const [key, value] of Object.entries(values)) config[key] = cell(value);
	config.modelPolicies = overrides.modelPolicies ?? [];
	return config;
}

function makeEngine(overrides = {}) {
	const calls = { compactIfNeeded: 0, compactNow: 0, triggers: [] };
	const engine = {
		config: Object.freeze({
			thresholdRatio: 0.8,
			headroomTokens: 65536,
			retainRatio: 0.16,
			summarizationProvider: "",
			summarizationModel: "",
			maxTokens: 65536,
			compactionRetries: 1,
			maxOverflowRetries: 1,
			modelPolicies: Object.freeze([]),
			auto: true
		}),
		async compactIfNeeded(agent, trigger) {
			calls.compactIfNeeded += 1;
			calls.triggers.push(trigger);
			return overrides.compactIfNeededResult ?? { shadowedSeqs: [3, 4, 5], shadowedTokenCount: 1234, summarySeq: 42 };
		},
		async compactNow(...args) {
			calls.compactNow += 1;
			if (overrides.compactNowError !== undefined) throw overrides.compactNowError;
			if (overrides.compactNow !== undefined) return overrides.compactNow(...args);
			return overrides.compactNowResult ?? { shadowedSeqs: [3], shadowedTokenCount: 999, summarySeq: 42 };
		},
		calls
	};
	return engine;
}

/** One fake host: listeners, services, pressure/window knobs, captured logs. */
function makeHost({ services = {}, pressure = 0, seq = 10, contextWindow = 1e6, provider = "p", model = "m" } = {}) {
	const listeners = new Map();
	const logs = { info: [], warn: [], debug: [] };
	const recorder = (level) => (message) => logs[level].push(String(message));
	const knobs = { pressure, seq, contextWindow };
	const session = {
		requestHeader: () => ({ config: { provider, model } }),
		get seq() { return knobs.seq; }
	};
	const agent = { session, options: {} };
	const target = {
		get: (name) => services[name],
		logger: { info: recorder("info"), warn: recorder("warn"), debug: recorder("debug") },
		on(name, listener) {
			if (!listeners.has(name)) listeners.set(name, []);
			listeners.get(name).push(listener);
			return () => {};
		},
		inject(names, callback) {
			if (names.every((name) => services[name] !== undefined)) callback(ctx);
		},
		effect(setup) {
			return setup();
		}
	};
	// cordis contexts expose services as properties (ctx.compaction), so the
	// fake mirrors services[name] for any name it does not define itself.
	const ctx = new Proxy(target, {
		get: (obj, prop) => prop in obj ? obj[prop] : services[prop],
		has: (obj, prop) => prop in obj || prop in services
	});
	return {
		ctx,
		agent,
		knobs,
		logs,
		services,
		async emit(name, payload = {}) {
			const registered = listeners.get(name) ?? [];
			for (const listener of registered) await listener(payload, () => ({ kind: "enter", messages: [] }));
		},
		async preStep(overrides = {}) {
			await this.emit("agent/pre-step", { agent, signal: overrides.signal ?? new AbortController().signal });
		},
		async idle() {
			await this.emit("agent/status", { agent, status: "idle" });
		},
		async running() {
			await this.emit("agent/status", { agent, status: "running" });
		}
	};
}

function standardServices(host, engine, { contextWindow, isolatedEngine, rootEngine, serviceForThrows } = {}) {
	const window = contextWindow ?? host.knobs.contextWindow;
	host.services.tokenMeter = { measure: () => ({ totalTokens: host.knobs.pressure }) };
	host.services.llm = {
		async resolveModelInfo() {
			return { context: { contextWindow: window } };
		}
	};
	if (isolatedEngine !== undefined || serviceForThrows === true) {
		// The desktop/web shape: the engine lives inside an agent preset's
		// isolated group and is reachable only through the registry seam.
		host.services.agentPresets = {
			serviceFor(_agent, name) {
				if (serviceForThrows === true) throw new Error("mount is changing");
				return name === "compaction" ? isolatedEngine : undefined;
			}
		};
	}
	if (rootEngine !== undefined) host.services.compaction = rootEngine;
	else if (engine !== undefined) host.services.compaction = engine;
	return host.services;
}

/** Fake settings seam: records update() calls and mirrors the volatile cell. */
function withSettings(host, config, { updateError } = {}) {
	const writes = [];
	host.services.settings = {
		async update(ns, patch) {
			if (updateError !== undefined) throw updateError;
			writes.push({ ns, patch });
			for (const [key, value] of Object.entries(patch)) config[key]?.set?.(value);
			return undefined;
		}
	};
	return writes;
}

const COMPACT_RESULT = { shadowedSeqs: [3, 4, 5], shadowedTokenCount: 1234, summarySeq: 42 };
const IDLE_RESULT = { shadowedSeqs: [3], shadowedTokenCount: 999, summarySeq: 42 };

/* ------------------------------------------------------------------ tests */

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("apply fails fast on an out-of-range thresholdRatio", () => {
	assert.throws(() => apply(makeHost().ctx, makeConfig({ thresholdRatio: 1.5 })), /thresholdRatio must be a ratio/u);
	assert.throws(() => apply(makeHost().ctx, makeConfig({ thresholdRatio: 0 })), /thresholdRatio must be a ratio/u);
});

test("apply fails fast when retainRatio is not below the tightest threshold", () => {
	assert.throws(() => apply(makeHost().ctx, makeConfig({ thresholdRatio: 0.4, retainRatio: 0.4 })), /retainRatio .* must be less/u);
	assert.throws(() => apply(makeHost().ctx, makeConfig({ thresholdRatio: 0.4, retainRatio: 0.2, modelPolicies: [{ provider: "p", model: "small", thresholdRatio: 0.15 }] })), /retainRatio .* must be less/u);
});

test("apply fails fast on invalid counts and per-model policies", () => {
	assert.throws(() => apply(makeHost().ctx, makeConfig({ cooldownSeconds: -1 })), /cooldownSeconds/u);
	assert.throws(() => apply(makeHost().ctx, makeConfig({ modelPolicies: [{ provider: "", model: "m", thresholdRatio: 0.5 }] })), /provider must be a non-empty string/u);
	assert.throws(() => apply(makeHost().ctx, makeConfig({ modelPolicies: [{ provider: "p", model: "m", thresholdRatio: 2 }] })), /thresholdRatio must be a ratio/u);
});

test("apply logs the armed threshold and registers both listeners", () => {
	const host = makeHost();
	standardServices(host, makeEngine());
	apply(host.ctx, makeConfig());
	assert.match(host.logs.info.join("\n"), /auto-compact: armed at 40% of the routed context window/u);
	await0(host);
	async function await0() {}
});

test("policy sync projects 40% onto the engine and preserves its other fields", async () => {
	const host = makeHost({ pressure: 1e3 });
	const engine = makeEngine();
	standardServices(host, engine);
	apply(host.ctx, makeConfig());
	await host.preStep();
	assert.equal(engine.config.thresholdRatio, 0.4);
	assert.equal(engine.config.retainRatio, 0.16);
	assert.equal(engine.config.headroomTokens, 65536);
	assert.equal(engine.config.maxTokens, 65536);
	assert.equal(engine.config.auto, true);
	assert.match(host.logs.info.join("\n"), /compaction threshold set to 40%/u);
});

test("policy sync is idempotent: no repeated log or churn below the threshold", async () => {
	const host = makeHost({ pressure: 1e3 });
	const engine = makeEngine();
	standardServices(host, engine);
	apply(host.ctx, makeConfig());
	await host.preStep();
	const first = engine.config;
	await host.preStep();
	assert.equal(engine.config, first);
	assert.equal(host.logs.info.filter((line) => /threshold set/u.test(line)).length, 1);
	assert.equal(engine.calls.compactIfNeeded, 0);
	assert.equal(engine.calls.compactNow, 0);
});

test("below the threshold: silence, no compaction calls", async () => {
	const host = makeHost({ pressure: 399_999, contextWindow: 1e6 });
	standardServices(host, makeEngine());
	apply(host.ctx, makeConfig());
	await host.preStep();
	assert.equal(host.logs.info.filter((line) => /tokens at/u.test(line)).length, 0);
	assert.equal(engineCalls(host).compactIfNeeded, 0);
	assert.equal(engineCalls(host).compactNow, 0);
});

test("at the threshold: crossing logged once; the engine's own auto path compacts, we do not double-call", async () => {
	const host = makeHost({ pressure: 400_000, contextWindow: 1e6 });
	const engine = makeEngine();
	standardServices(host, engine);
	apply(host.ctx, makeConfig());
	await host.preStep();
	await host.preStep();
	assert.equal(host.logs.info.filter((line) => /400,000 tokens at 40%/u.test(line)).length, 1);
	assert.equal(engine.calls.compactIfNeeded, 0, "auto engine owns the compaction; the plugin must not duplicate it");
	assert.equal(engine.calls.compactNow, 0);
});

test("engine with auto:false gets the plugin driving its pressure path", async () => {
	const host = makeHost({ pressure: 500_000, contextWindow: 1e6 });
	const engine = makeEngine();
	engine.config = Object.freeze({ ...engine.config, auto: false });
	standardServices(host, engine);
	apply(host.ctx, makeConfig());
	await host.preStep();
	assert.equal(engine.calls.compactIfNeeded, 1);
	assert.deepEqual(engine.calls.triggers, ["pressure"]);
	assert.match(host.logs.info.join("\n"), /compacted 3 items \(~1,234 tokens\) before a request/u);
});

test("idle sweep compacts through compactNow when pressure is at or above the threshold", async () => {
	const host = makeHost({ pressure: 450_000, contextWindow: 1e6 });
	standardServices(host, makeEngine());
	apply(host.ctx, makeConfig());
	await host.running();
	await host.idle();
	assert.equal(engineCalls(host).compactNow, 1);
	assert.match(host.logs.info.join("\n"), /45% pressure while idle .* compacting before the next turn/u);
	assert.match(host.logs.info.join("\n"), /compacted 1 items \(~999 tokens\) while idle/u);
});

test("idle sweep stays quiet below the threshold", async () => {
	const host = makeHost({ pressure: 1000, contextWindow: 1e6 });
	standardServices(host, makeEngine());
	apply(host.ctx, makeConfig());
	await host.idle();
	assert.equal(engineCalls(host).compactNow, 0);
});

test("idle sweep honors the per-agent cooldown and the log-growth guard", async () => {
	const host = makeHost({ pressure: 450_000, contextWindow: 1e6 });
	standardServices(host, makeEngine());
	apply(host.ctx, makeConfig({ cooldownSeconds: 60 }));
	await host.idle();
	await host.idle();
	assert.equal(engineCalls(host).compactNow, 1, "same log revision must not re-trigger");
	host.knobs.seq += 1;
	await host.idle();
	assert.equal(engineCalls(host).compactNow, 1, "cooldown must suppress the retry");
});

test("idle sweep retries after the cooldown once the log grew", async () => {
	const host = makeHost({ pressure: 450_000, contextWindow: 1e6 });
	standardServices(host, makeEngine());
	apply(host.ctx, makeConfig({ cooldownSeconds: 0 }));
	await host.idle();
	host.knobs.seq += 1;
	await host.idle();
	assert.equal(engineCalls(host).compactNow, 2);
});

test("idle sweep swallows busy/cancelled and warns on real failures", async () => {
	const busy = Object.assign(new Error("agent busy"), { name: "ManualCompactionError", code: "busy" });
	const host = makeHost({ pressure: 450_000, contextWindow: 1e6 });
	standardServices(host, makeEngine({ compactNowError: busy }));
	apply(host.ctx, makeConfig({ cooldownSeconds: 0 }));
	await host.idle();
	assert.equal(engineCalls(host).compactNow, 1);
	assert.equal(host.logs.warn.length, 0);

	const failure = Object.assign(new Error("summary failed"), { name: "ManualCompactionError", code: "summary" });
	const host2 = makeHost({ pressure: 450_000, contextWindow: 1e6, model: "m2" });
	standardServices(host2, makeEngine({ compactNowError: failure }));
	apply(host2.ctx, makeConfig({ cooldownSeconds: 0 }));
	await host2.idle();
	assert.match(host2.logs.warn.join("\n"), /idle compaction failed \(summary\): summary failed/u);
});

test("idle sweeps are serialized per agent", async () => {
	const host = makeHost({ pressure: 450_000, contextWindow: 1e6 });
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	standardServices(host, makeEngine({
		compactNow: async () => {
			await gate;
			return IDLE_RESULT;
		}
	}));
	apply(host.ctx, makeConfig({ cooldownSeconds: 0 }));
	await host.idle();
	host.knobs.seq += 1;
	await host.idle();
	assert.equal(engineCalls(host).compactNow, 1, "an in-flight sweep must suppress the next one");
	release();
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
});

test("runtime threshold edits re-project onto the engine at the next step", async () => {
	const host = makeHost({ pressure: 1e3, contextWindow: 1e6, model: "m3" });
	const engine = makeEngine();
	standardServices(host, engine);
	const config = makeConfig();
	apply(host.ctx, config);
	await host.preStep();
	assert.equal(engine.config.thresholdRatio, 0.4);
	config.thresholdRatio.set(0.6);
	await host.preStep();
	assert.equal(engine.config.thresholdRatio, 0.6);
	assert.match(host.logs.info.join("\n"), /threshold set to 60%/u);
});

test("an engine reload that resets its config is re-asserted at the next step", async () => {
	const host = makeHost({ pressure: 1e3, contextWindow: 1e6, model: "m4" });
	const engine = makeEngine();
	standardServices(host, engine);
	apply(host.ctx, makeConfig());
	await host.preStep();
	engine.config = Object.freeze({ ...engine.config, thresholdRatio: 0.8 });
	await host.preStep();
	assert.equal(engine.config.thresholdRatio, 0.4);
});

test("per-model overrides merge into the engine policy table", async () => {
	const host = makeHost({ pressure: 1e3, contextWindow: 1e6, model: "m5" });
	const engine = makeEngine();
	standardServices(host, engine);
	apply(host.ctx, makeConfig({
		modelPolicies: [
			{ provider: "p", model: "m5", thresholdRatio: 0.25 },
			{ provider: "p", model: "other", thresholdRatio: 0.5 }
		]
	}));
	await host.preStep();
	assert.deepEqual(engine.config.modelPolicies, [
		{ provider: "p", model: "m5", thresholdRatio: 0.25 },
		{ provider: "p", model: "other", thresholdRatio: 0.5 }
	]);
	assert.equal(engine.config.thresholdRatio, 0.4);
});

test("retainTokens replaces retainRatio as a single form; headroom moves a defaulted maxTokens", async () => {
	const host = makeHost({ pressure: 1e3, contextWindow: 1e6, model: "m6" });
	const engine = makeEngine();
	standardServices(host, engine);
	apply(host.ctx, makeConfig({ retainTokens: 4096, headroomTokens: 8192 }));
	await host.preStep();
	assert.equal(engine.config.retainTokens, 4096);
	assert.equal("retainRatio" in engine.config, false);
	assert.equal(engine.config.headroomTokens, 8192);
	assert.equal(engine.config.maxTokens, 8192);
});

test("headroom does not move an explicitly configured maxTokens", async () => {
	const host = makeHost({ pressure: 1e3, contextWindow: 1e6, model: "m7" });
	const engine = makeEngine();
	engine.config = Object.freeze({ ...engine.config, maxTokens: 12345 });
	standardServices(host, engine);
	apply(host.ctx, makeConfig({ headroomTokens: 8192 }));
	await host.preStep();
	assert.equal(engine.config.maxTokens, 12345);
	assert.equal(engine.config.headroomTokens, 8192);
});

test("without a compaction engine the observer still reports crossings and never throws", async () => {
	const host = makeHost({ pressure: 500_000, contextWindow: 1e6, model: "m8" });
	standardServices(host, undefined);
	apply(host.ctx, makeConfig());
	await host.preStep();
	assert.match(host.logs.info.join("\n"), /500,000 tokens at 50%/u);
	await host.idle();
	assert.equal(host.logs.warn.length, 0);
});

test("the engine inside an agent preset's isolated group is found and patched (desktop shape)", async () => {
	const host = makeHost({ pressure: 500_000, contextWindow: 1e6, model: "m20" });
	const engine = makeEngine();
	standardServices(host, undefined, { isolatedEngine: engine });
	apply(host.ctx, makeConfig());
	await host.preStep();
	assert.equal(engine.config.thresholdRatio, 0.4);
	assert.match(host.logs.info.join("\n"), /threshold set to 40%/u);
});

test("the agent's isolated engine wins over a root-plane engine", async () => {
	const host = makeHost({ pressure: 1e3, contextWindow: 1e6, model: "m21" });
	const isolated = makeEngine();
	const root = makeEngine();
	standardServices(host, undefined, { isolatedEngine: isolated, rootEngine: root });
	apply(host.ctx, makeConfig());
	await host.preStep();
	assert.equal(isolated.config.thresholdRatio, 0.4);
	assert.equal(root.config.thresholdRatio, 0.8, "the root-plane engine must stay untouched");
});

test("a throwing serviceFor falls back to the root-plane engine", async () => {
	const host = makeHost({ pressure: 1e3, contextWindow: 1e6, model: "m22" });
	const root = makeEngine();
	standardServices(host, root, { serviceForThrows: true });
	apply(host.ctx, makeConfig());
	await host.preStep();
	assert.equal(root.config.thresholdRatio, 0.4);
});

test("the idle sweep compacts through the isolated preset engine", async () => {
	const host = makeHost({ pressure: 450_000, contextWindow: 1e6, model: "m23" });
	const engine = makeEngine();
	standardServices(host, undefined, { isolatedEngine: engine });
	apply(host.ctx, makeConfig());
	await host.running();
	await host.idle();
	assert.equal(engine.calls.compactNow, 1);
	assert.match(host.logs.info.join("\n"), /compacted 1 items \(~999 tokens\) while idle/u);
});

test("the status command reports the isolated engine as synced", async () => {
	const host = makeHost({ pressure: 123_456, contextWindow: 1e6, model: "m24" });
	const engine = makeEngine();
	standardServices(host, undefined, { isolatedEngine: engine });
	const registered = [];
	host.services.commands = { register: (definition) => { registered.push(definition); return () => {}; } };
	apply(host.ctx, makeConfig());
	await host.preStep();
	const ok = await registered[0].handler({ agent: host.agent, rawInput: "", signal: new AbortController().signal });
	assert.match(ok.text, /policy synced \(automatic compaction on; active threshold 40%\)/u);
});

test("a preset-mounted engine without a patchable policy leaves the sweep as the only path", async () => {
	const host = makeHost({ pressure: 450_000, contextWindow: 1e6, model: "m25" });
	const opaque = { compactNow: async () => IDLE_RESULT };
	standardServices(host, undefined, { isolatedEngine: opaque });
	apply(host.ctx, makeConfig());
	await host.preStep();
	assert.equal(host.logs.info.filter((line) => /threshold set/u.test(line)).length, 0);
	await host.idle();
	assert.equal(host.logs.info.filter((line) => /compacted 1 items/u.test(line)).length, 1);
});

test("the status command applies the policy before reporting it (no step has run yet)", async () => {
	const host = makeHost({ pressure: 123_456, contextWindow: 1e6, model: "m26" });
	const engine = makeEngine();
	standardServices(host, undefined, { isolatedEngine: engine });
	const registered = [];
	host.services.commands = { register: (definition) => { registered.push(definition); return () => {}; } };
	apply(host.ctx, makeConfig());
	const ok = await registered[0].handler({ agent: host.agent, rawInput: "", signal: new AbortController().signal });
	assert.equal(engine.config.thresholdRatio, 0.4, "the report must self-heal the engine policy");
	assert.match(ok.text, /policy synced \(automatic compaction on; active threshold 40%\)/u);
});

test("the idle sweep applies the policy before its threshold check", async () => {
	const host = makeHost({ pressure: 450_000, contextWindow: 1e6, model: "m27" });
	const engine = makeEngine();
	standardServices(host, undefined, { isolatedEngine: engine });
	apply(host.ctx, makeConfig());
	await host.running();
	await host.idle();
	assert.equal(engine.config.thresholdRatio, 0.4);
	assert.equal(engine.calls.compactNow, 1);
});

test("a disabled plugin's status command reports but never patches the engine", async () => {
	const host = makeHost({ pressure: 123_456, contextWindow: 1e6, model: "m28" });
	const engine = makeEngine();
	standardServices(host, undefined, { isolatedEngine: engine });
	const registered = [];
	host.services.commands = { register: (definition) => { registered.push(definition); return () => {}; } };
	apply(host.ctx, makeConfig({ enabled: false }));
	const ok = await registered[0].handler({ agent: host.agent, rawInput: "", signal: new AbortController().signal });
	assert.equal(engine.config.thresholdRatio, 0.8);
	assert.match(ok.text, /enabled: no/u);
});

test("/autocompact 30 persists the threshold through the settings seam and syncs the engine", async () => {
	const host = makeHost({ pressure: 123_456, contextWindow: 1e6, model: "m30" });
	const engine = makeEngine();
	standardServices(host, undefined, { isolatedEngine: engine });
	const registered = [];
	host.services.commands = { register: (definition) => { registered.push(definition); return () => {}; } };
	const config = makeConfig();
	const writes = withSettings(host, config);
	apply(host.ctx, config);
	const ok = await registered[0].handler({ agent: host.agent, rawInput: "30", signal: new AbortController().signal });
	assert.equal(ok.kind, "success");
	assert.deepEqual(writes, [{ ns: "auto-compact", patch: { thresholdRatio: 0.3 } }]);
	assert.equal(engine.config.thresholdRatio, 0.3, "the engine must carry the new threshold immediately");
	assert.match(ok.text, /threshold set to 30%.*engine active threshold 30%/u);
	const status = await registered[0].handler({ agent: host.agent, rawInput: "", signal: new AbortController().signal });
	assert.match(status.text, /threshold: 30% of the routed model's context window/u);
});

test("/autocompact accepts a percent sign and decimals, and rejects nonsense", async () => {
	const host = makeHost({ pressure: 123_456, contextWindow: 1e6, model: "m31" });
	const engine = makeEngine();
	standardServices(host, undefined, { isolatedEngine: engine });
	const registered = [];
	host.services.commands = { register: (definition) => { registered.push(definition); return () => {}; } };
	const config = makeConfig();
	withSettings(host, config);
	apply(host.ctx, config);
	const run = (rawInput) => registered[0].handler({ agent: host.agent, rawInput, signal: new AbortController().signal });
	assert.match((await run("42.5%")).text, /threshold set to 42.5%/u);
	for (const bad of ["abc", "0", "100", "-5", "30 tokens", "30%%"]) {
		const rejected = await run(bad);
		assert.equal(rejected.kind, "error", `input ${bad} must be rejected`);
		assert.match(rejected.text, /Usage: \/autocompact/u);
	}
});

test("/autocompact rejects a threshold at or below the configured retainRatio", async () => {
	const host = makeHost({ pressure: 123_456, contextWindow: 1e6, model: "m32" });
	const engine = makeEngine();
	standardServices(host, undefined, { isolatedEngine: engine });
	const registered = [];
	host.services.commands = { register: (definition) => { registered.push(definition); return () => {}; } };
	const config = makeConfig({ retainRatio: 0.16 });
	const writes = withSettings(host, config);
	apply(host.ctx, config);
	const ok = await registered[0].handler({ agent: host.agent, rawInput: "10", signal: new AbortController().signal });
	assert.equal(ok.kind, "error");
	assert.match(ok.text, /not above the configured retainRatio \(16%\)/u);
	assert.equal(writes.length, 0, "an invalid threshold must not be persisted");
	assert.equal(engine.config.thresholdRatio, 0.8);
});

test("/autocompact reports a settings failure without touching the engine", async () => {
	const host = makeHost({ pressure: 123_456, contextWindow: 1e6, model: "m33" });
	const engine = makeEngine();
	standardServices(host, undefined, { isolatedEngine: engine });
	const registered = [];
	host.services.commands = { register: (definition) => { registered.push(definition); return () => {}; } };
	const config = makeConfig();
	withSettings(host, config, { updateError: Object.assign(new Error("disk full"), { name: "Error" }) });
	apply(host.ctx, config);
	const ok = await registered[0].handler({ agent: host.agent, rawInput: "25", signal: new AbortController().signal });
	assert.equal(ok.kind, "error");
	assert.match(ok.text, /could not persist the threshold: disk full/u);
	assert.equal(engine.config.thresholdRatio, 0.8);
});

test("/autocompact explains when no settings service is mounted", async () => {
	const host = makeHost({ pressure: 123_456, contextWindow: 1e6, model: "m34" });
	standardServices(host, undefined, { isolatedEngine: makeEngine() });
	const registered = [];
	host.services.commands = { register: (definition) => { registered.push(definition); return () => {}; } };
	apply(host.ctx, makeConfig());
	const ok = await registered[0].handler({ agent: host.agent, rawInput: "25", signal: new AbortController().signal });
	assert.equal(ok.kind, "error");
	assert.match(ok.text, /no settings service is mounted/u);
});

test("enabled:false silences every trigger", async () => {
	const host = makeHost({ pressure: 900_000, contextWindow: 1e6, model: "m9" });
	const engine = makeEngine();
	standardServices(host, engine);
	apply(host.ctx, makeConfig({ enabled: false }));
	await host.preStep();
	await host.idle();
	assert.equal(engine.config.thresholdRatio, 0.8, "a disabled plugin must not touch the engine");
	assert.equal(engine.calls.compactIfNeeded, 0);
	assert.equal(engine.calls.compactNow, 0);
	assert.equal(host.logs.info.filter((line) => /tokens at/u.test(line)).length, 0);
});

test("an aborted step signal skips the check", async () => {
	const host = makeHost({ pressure: 900_000, contextWindow: 1e6, model: "m10" });
	const engine = makeEngine();
	standardServices(host, engine);
	apply(host.ctx, makeConfig());
	const controller = new AbortController();
	controller.abort();
	await host.emit("agent/pre-step", { agent: host.agent, signal: controller.signal });
	assert.equal(engine.config.thresholdRatio, 0.8);
});

test("/autocompact reports status and rejects arguments", async () => {
	const host = makeHost({ pressure: 123_456, contextWindow: 1e6, model: "m11" });
	const engine = makeEngine();
	standardServices(host, engine);
	const registered = [];
	host.services.commands = { register: (definition) => { registered.push(definition); return () => {}; } };
	apply(host.ctx, makeConfig());
	await host.preStep();
	assert.equal(registered.length, 1);
	const command = registered[0];
	assert.equal(command.name, "autocompact");
	assert.equal(command.definitionId, "dsh-auto-compact");
	const ok = await command.handler({ agent: host.agent, rawInput: "", signal: new AbortController().signal });
	assert.equal(ok.kind, "success");
	assert.match(ok.text, /threshold: 40% of the routed model's context window/u);
	assert.match(ok.text, /route: p\/m11/u);
	assert.match(ok.text, /pressure: 123,456 tokens/u);
	assert.match(ok.text, /policy synced \(automatic compaction on; active threshold 40%\)/u);
	const bad = await command.handler({ agent: host.agent, rawInput: "now", signal: new AbortController().signal });
	assert.equal(bad.kind, "error");
	assert.match(bad.text, /Usage: \/autocompact/u);
});

test("resolveSettings normalizes policies for direct consumers", () => {
	const settings = resolveSettings(makeConfig({ modelPolicies: [{ provider: "p", model: "m", thresholdRatio: 0.3 }] }));
	assert.equal(settings.thresholdRatio, 0.4);
	assert.deepEqual(settings.modelPolicies, [{ provider: "p", model: "m", thresholdRatio: 0.3 }]);
});

function engineCalls(host) {
	return host.services.compaction.calls;
}

let failed = 0;
for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`PASS  ${name}`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL  ${name}\n      ${String(error).split("\n")[0]}`);
	}
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
