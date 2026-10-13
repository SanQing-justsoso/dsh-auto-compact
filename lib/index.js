import z from "@deepseek-ai/schemastery";
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
/**
 * Early automatic conversation compaction for DeepSeek Harness.
 *
 * The host already ships a compaction engine (`@deepseek-ai/dsh-compaction-basic`)
 * whose automatic path condenses history once measured pressure crosses a
 * per-model threshold, defaulting to 80% of the context window. This plugin
 * moves that threshold to a configurable fraction — 40% by default — so long
 * conversations are condensed early instead of near the limit.
 *
 * Three mechanisms, in order of reliance:
 *
 * 1. **Policy sync (primary).** The plugin projects its threshold policy onto
 *    the mounted engine's resolved configuration (`thresholdRatio`, optional
 *    retention/headroom overrides, optional per-model overrides). The engine's
 *    own `agent/pre-step` listener then compacts mid-turn at the synced
 *    threshold, reusing its native balanced-range selection, summarization,
 *    durable commit, and overflow recovery. The sync is idempotent and re-asserts
 *    itself on every step, so runtime config edits and engine reloads are picked
 *    up without a restart.
 * 2. **Pressure listener (fallback).** When the engine has automatic compaction
 *    switched off (`auto: false`), the plugin drives the engine's public
 *    `compactIfNeeded()` pressure path itself at the same threshold.
 * 3. **Idle sweep (boundary guarantee).** On every transition to idle the plugin
 *    measures pressure and, when at or above the threshold, runs the engine's
 *    public `compactNow()` — the same entry the `/compact` command uses. This
 *    catches pressure that crossed the threshold after the last step of a turn
 *    (a long final assistant message, a large claimed input) and covers
 *    compositions whose engine does not expose a patchable policy.
 *
 * Everything the plugin touches is feature-detected: a composition without a
 * compaction engine, token meter, or LLM service degrades to logging instead of
 * failing, and no listener ever breaks a turn. `/autocompact` reports the live
 * policy, and `/autocompact 30` picks a new threshold percentage — persisted
 * through the settings seam into the profile patch, applied live.
 *
 * Engine resolution covers both composition shapes the host ships: base
 * compositions mount the engine on the root plane, while the web/desktop app
 * mounts it inside an agent preset's isolated group, where root-plane
 * consumers cannot see it. Each trigger therefore resolves the engine per
 * agent through the preset registry's `serviceFor()` seam first and the root
 * plane second, so one build works in headless and GUI profiles alike.
 *
 * @module dsh-auto-compact
 */
//#region config
/** Default context-window fraction that triggers compaction. */
const DEFAULT_THRESHOLD_RATIO = 0.4;
/** Default minimum seconds between idle-boundary compaction attempts per agent. */
const DEFAULT_COOLDOWN_SECONDS = 30;
/** Cordis plugin name used by loader diagnostics. */
const name = "auto-compact";
/** Profile entry id this bundle inserts itself under; the settings seam addresses it. */
const ENTRY_ID = "auto-compact";
/** Command name registered when a command registry is mounted. */
const COMMAND_NAME = "autocompact";
const USAGE = "Usage: /autocompact [percent] — no arguments shows status; a percent (for example 30 or 42.5%) sets the compaction threshold";
const ratioSchema = z.number();
const tokenCountSchema = z.number().step(1).min(0);
const modelPolicySchema = z.object({
	provider: z.string().required(),
	model: z.string().required(),
	thresholdRatio: ratioSchema
});
/**
 * Plugin configuration. Scalar fields are volatile so a settings editor can
 * retune the threshold without reloading the profile; the merged policy is
 * re-projected onto the engine at the next step. `modelPolicies` is load-time
 * only, mirroring the engine's own per-model override table.
 */
const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	thresholdRatio: ratioSchema.default(DEFAULT_THRESHOLD_RATIO).volatile(),
	retainRatio: ratioSchema.volatile(),
	retainTokens: tokenCountSchema.volatile(),
	headroomTokens: tokenCountSchema.volatile(),
	cooldownSeconds: tokenCountSchema.default(DEFAULT_COOLDOWN_SECONDS).volatile(),
	modelPolicies: z.array(modelPolicySchema)
});
/** No hard service dependencies: every seam is optional and feature-detected. */
const inject = [];
//#endregion
//#region settings
/**
 * Read and validate the live configuration into a plain settings object.
 * @param config - plugin config cells from the loader.
 * @returns validated settings with normalized model policies.
 * @throws when a value is outside its documented domain (fail-fast, like every
 *   other dsh policy plugin).
 */
function resolveSettings(config) {
	const settings = {
		enabled: config.enabled.get(),
		thresholdRatio: config.thresholdRatio.get(),
		retainRatio: config.retainRatio.get(),
		retainTokens: config.retainTokens.get(),
		headroomTokens: config.headroomTokens.get(),
		cooldownSeconds: config.cooldownSeconds.get(),
		modelPolicies: config.modelPolicies ?? []
	};
	assertRatio("thresholdRatio", settings.thresholdRatio);
	if (settings.retainRatio !== undefined) assertRatio("retainRatio", settings.retainRatio);
	if (settings.retainTokens !== undefined) assertCount("retainTokens", settings.retainTokens);
	if (settings.headroomTokens !== undefined) assertCount("headroomTokens", settings.headroomTokens);
	assertCount("cooldownSeconds", settings.cooldownSeconds);
	const policies = [];
	for (const [index, source] of settings.modelPolicies.entries()) {
		if (!isRecord(source)) throw new Error(`dsh-auto-compact: modelPolicies[${index}] must be an object`);
		const { provider, model, thresholdRatio } = source;
		if (typeof provider !== "string" || provider.length === 0) throw new Error(`dsh-auto-compact: modelPolicies[${index}].provider must be a non-empty string`);
		if (typeof model !== "string" || model.length === 0) throw new Error(`dsh-auto-compact: modelPolicies[${index}].model must be a non-empty string`);
		assertRatio(`modelPolicies[${index}].thresholdRatio`, thresholdRatio);
		policies.push({ provider, model, thresholdRatio });
	}
	settings.modelPolicies = policies;
	const tightest = Math.min(settings.thresholdRatio, ...policies.map((policy) => policy.thresholdRatio));
	if (settings.retainRatio !== undefined && settings.retainRatio >= tightest) throw new Error(`dsh-auto-compact: retainRatio (${settings.retainRatio}) must be less than the tightest thresholdRatio (${tightest})`);
	return settings;
}
function assertRatio(field, value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) throw new Error(`dsh-auto-compact: ${field} must be a ratio in (0, 1), received ${String(value)}`);
}
function assertCount(field, value) {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`dsh-auto-compact: ${field} must be a non-negative integer, received ${String(value)}`);
}
//#endregion
//#region engine policy sync
/**
 * Project the plugin's threshold policy onto one resolved engine config.
 *
 * The engine's own `resolveConfig()` validation ran at its load time with the
 * profile's values; this projection bypasses that constructor, so it performs
 * the same domain checks by construction: the threshold stays a ratio in
 * (0, 1), retention keeps exactly one form (absolute tokens win, matching the
 * engine's `resolveRetention`), and `maxTokens` follows `headroomTokens`
 * exactly when it was defaulted from the previous headroom.
 * @param engineConfig - the engine's current resolved (frozen) configuration.
 * @param settings - validated plugin settings.
 * @returns a new frozen config when anything differs, or `null` when the
 *   engine already carries this policy.
 */
function patchEngineConfig(engineConfig, settings) {
	if (engineConfig.thresholdRatio === settings.thresholdRatio && settings.retainRatio === undefined && settings.retainTokens === undefined && settings.headroomTokens === undefined && settings.modelPolicies.length === 0) return null;
	const next = { ...engineConfig };
	let changed = false;
	if (next.thresholdRatio !== settings.thresholdRatio) {
		next.thresholdRatio = settings.thresholdRatio;
		changed = true;
	}
	if (settings.retainTokens !== undefined) {
		if (next.retainTokens !== settings.retainTokens || "retainRatio" in next) {
			delete next.retainRatio;
			next.retainTokens = settings.retainTokens;
			changed = true;
		}
	} else if (settings.retainRatio !== undefined) {
		if (next.retainRatio !== settings.retainRatio || "retainTokens" in next) {
			delete next.retainTokens;
			next.retainRatio = settings.retainRatio;
			changed = true;
		}
	}
	if (settings.headroomTokens !== undefined && next.headroomTokens !== settings.headroomTokens) {
		const maxTokensFollowedHeadroom = next.maxTokens === engineConfig.headroomTokens;
		next.headroomTokens = settings.headroomTokens;
		if (maxTokensFollowedHeadroom) next.maxTokens = settings.headroomTokens;
		changed = true;
	}
	const policies = mergeModelPolicies(next.modelPolicies, settings.modelPolicies);
	if (policies !== null) {
		next.modelPolicies = policies;
		changed = true;
	}
	return changed ? deepFreeze(next) : null;
}
/**
 * Merge per-model threshold overrides over the engine's resolved policy table.
 * @param existing - engine-owned policy entries (possibly frozen).
 * @param overrides - validated plugin overrides.
 * @returns a new array when any entry changes or is added, else `null`.
 */
function mergeModelPolicies(existing, overrides) {
	if (overrides.length === 0) return null;
	const merged = Array.isArray(existing) ? existing.map((entry) => ({ ...entry })) : [];
	let changed = false;
	for (const override of overrides) {
		const index = merged.findIndex((entry) => entry?.provider === override.provider && entry?.model === override.model);
		if (index === -1) {
			merged.push({ provider: override.provider, model: override.model, thresholdRatio: override.thresholdRatio });
			changed = true;
			continue;
		}
		const entry = { ...merged[index], thresholdRatio: override.thresholdRatio };
		if (!samePolicy(merged[index], entry)) {
			merged[index] = entry;
			changed = true;
		}
	}
	return changed ? merged : null;
}
function samePolicy(left, right) {
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) if (left[key] !== right[key]) return false;
	return true;
}
function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) deepFreeze(value[key]);
	}
	return value;
}
/**
 * Resolve the compaction engine that serves one agent.
 *
 * Two composition shapes exist: base compositions mount the engine on the root
 * plane (`ctx.get("compaction")`), while the web/desktop app mounts it inside
 * an agent preset's isolated group (`isolate: { compaction: true }`), where it
 * is invisible to root-plane consumers. The preset registry's
 * `agentPresets.serviceFor(agent, name)` is the documented read seam for that
 * isolated instance, so the agent's own engine wins and the root plane is the
 * fallback.
 * @param ctx - plugin context.
 * @param agent - agent whose engine is resolved; `undefined` resolves the root plane only.
 * @returns the engine record, or `undefined` when none is mounted.
 */
function engineFor(ctx, agent) {
	if (agent !== undefined) {
		const presets = ctx.get("agentPresets");
		if (isRecord(presets) && typeof presets.serviceFor === "function") {
			try {
				const isolated = presets.serviceFor(agent, "compaction");
				if (isRecord(isolated)) return isolated;
			} catch (error) {
				ctx.logger.debug(`auto-compact: preset engine lookup failed: ${errorMessage(error)}`);
			}
		}
	}
	const root = ctx.get("compaction");
	return isRecord(root) ? root : undefined;
}
/**
 * Narrow one engine record to the Basic engine's patchable policy surface.
 * Any other implementation is left untouched; the idle sweep still works
 * through its public `compactNow()`.
 * @param engine - candidate engine record.
 * @returns the engine when patchable, else `undefined`.
 */
function patchableEngine(engine) {
	if (!isRecord(engine)) return undefined;
	if (!isRecord(engine.config) || typeof engine.config.thresholdRatio !== "number") return undefined;
	if (typeof engine.config.auto !== "boolean") return undefined;
	if (typeof engine.compactIfNeeded !== "function") return undefined;
	return engine;
}
/**
 * Re-assert the plugin policy onto the engine, idempotently. The engine reads
 * its `config` at call time, so a late sync (first step, runtime config edit,
 * engine reload) takes effect on the very next decision without restarting
 * anything.
 * @param ctx - plugin context.
 * @param engine - patchable compaction engine.
 * @param settings - validated plugin settings.
 */
function syncEnginePolicy(ctx, engine, settings) {
	const patched = patchEngineConfig(engine.config, settings);
	if (patched === null) return;
	engine.config = patched;
	const policies = settings.modelPolicies.length === 0 ? "" : `; per-model ${settings.modelPolicies.map((policy) => `${policy.provider}/${policy.model} ${formatRatio(policy.thresholdRatio)}`).join(", ")}`;
	ctx.logger.info(`auto-compact: compaction threshold set to ${formatRatio(settings.thresholdRatio)} of the context window${policies}`);
}
//#endregion
//#region measurement
/** Routed provider/model for pressure decisions: latest durable request, else the agent's selection. */
function routedTarget(agent) {
	const header = agent.session.requestHeader?.();
	const config = header?.config;
	if (isRecord(config) && isNonEmptyString(config.provider) && isNonEmptyString(config.model)) return { provider: config.provider, model: config.model };
	const options = agent.options;
	if (isRecord(options) && isNonEmptyString(options.provider) && isNonEmptyString(options.model)) return { provider: options.provider, model: options.model };
	return undefined;
}
/** Per-agent mutable sweep state. */
const agentStates = /* @__PURE__ */ new WeakMap();
function stateFor(agent) {
	let state = agentStates.get(agent);
	if (state === undefined) {
		state = {
			above: false,
			inFlight: null,
			lastAttemptSeq: -1,
			lastAttemptAt: 0,
			lastReport: ""
		};
		agentStates.set(agent, state);
	}
	return state;
}
/** Cached context windows; a route's capacity is static configuration. */
const contextWindows = /* @__PURE__ */ new Map();
const windowWarnings = /* @__PURE__ */ new Set();
/**
 * Resolve one route's context window through the LLM service, cached per route.
 * @returns the positive integer window, or `undefined` when unavailable.
 */
async function contextWindowOf(ctx, target, signal) {
	const key = `${target.provider}\u0000${target.model}`;
	const cached = contextWindows.get(key);
	if (cached !== undefined) return cached;
	const llm = ctx.get("llm");
	if (!isRecord(llm) || typeof llm.resolveModelInfo !== "function") return undefined;
	try {
		const info = await llm.resolveModelInfo(target.provider, target.model, signal);
		const contextWindow = info?.context?.contextWindow;
		if (typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0) {
			contextWindows.set(key, contextWindow);
			return contextWindow;
		}
	} catch (error) {
		if (!windowWarnings.has(key)) {
			windowWarnings.add(key);
			ctx.logger.warn(`auto-compact: cannot resolve the context window for ${target.provider}/${target.model}: ${errorMessage(error)}`);
		}
	}
	return undefined;
}
/** Current pressure through the token meter, or `undefined` when unmounted. */
function measurePressure(ctx, agent) {
	const meter = ctx.get("tokenMeter");
	if (!isRecord(meter) || typeof meter.measure !== "function") return undefined;
	const measurement = meter.measure(agent.session);
	return isRecord(measurement) && typeof measurement.totalTokens === "number" ? measurement : undefined;
}
//#endregion
//#region triggers
/**
 * Pre-step observer: report threshold crossings and, when the engine's own
 * automatic listener is switched off, drive its public pressure path at the
 * synced threshold. Never blocks or rejects the step.
 */
async function observePreStep(ctx, config, agent, signal) {
	const settings = resolveSettings(config);
	if (!settings.enabled) return;
	const engine = patchableEngine(engineFor(ctx, agent));
	if (engine !== undefined) syncEnginePolicy(ctx, engine, settings);
	const target = routedTarget(agent);
	if (target === undefined) return;
	const contextWindow = await contextWindowOf(ctx, target, signal);
	if (contextWindow === undefined || signal.aborted) return;
	const threshold = Math.floor(contextWindow * settings.thresholdRatio);
	const tokens = measurePressure(ctx, agent)?.totalTokens ?? 0;
	const state = stateFor(agent);
	if (tokens < threshold) {
		if (state.above) {
			state.above = false;
			ctx.logger.debug(`auto-compact: pressure back below the threshold (${formatTokens(tokens)} < ${formatTokens(threshold)} tokens)`);
		}
		return;
	}
	if (!state.above) {
		state.above = true;
		ctx.logger.info(`auto-compact: ${formatTokens(tokens)} tokens at ${formatRatio(tokens / contextWindow)} of the ${formatTokens(contextWindow)}-token window on ${target.provider}/${target.model} (threshold ${formatRatio(settings.thresholdRatio)})`);
	}
	if (engine === undefined || engine.config.auto === true || typeof engine.compactIfNeeded !== "function") return;
	const result = await engine.compactIfNeeded(agent, "pressure", signal);
	if (result === null) return;
	state.above = false;
	state.lastReport = `compacted ${result.shadowedSeqs.length} items (~${formatTokens(result.shadowedTokenCount)} tokens) before a request`;
	ctx.logger.info(`auto-compact: ${state.lastReport}`);
}
/**
 * Idle-boundary sweep: compact through the engine's public manual entry when
 * pressure sits at or above the threshold and the log grew since the last
 * attempt. Serialized per agent and rate-limited by `cooldownSeconds`, so a
 * session whose history cannot shrink further is retried at most once per
 * cooldown window instead of on every turn.
 */
async function idleSweep(ctx, settings, agent, state) {
	const engine = engineFor(ctx, agent);
	if (!isRecord(engine) || typeof engine.compactNow !== "function") return;
	const patchable = patchableEngine(engine);
	if (patchable !== undefined) syncEnginePolicy(ctx, patchable, settings);
	const seq = agent.session.seq;
	if (typeof seq !== "number" || seq === state.lastAttemptSeq) return;
	const now = Date.now();
	if (now - state.lastAttemptAt < settings.cooldownSeconds * 1e3) return;
	const target = routedTarget(agent);
	if (target === undefined) return;
	const controller = new AbortController();
	const contextWindow = await contextWindowOf(ctx, target, controller.signal);
	if (contextWindow === undefined || controller.signal.aborted) return;
	const threshold = Math.floor(contextWindow * settings.thresholdRatio);
	const tokens = measurePressure(ctx, agent)?.totalTokens ?? 0;
	if (tokens < threshold) return;
	state.lastAttemptSeq = seq;
	state.lastAttemptAt = now;
	ctx.logger.info(`auto-compact: ${formatRatio(tokens / contextWindow)} pressure while idle (${formatTokens(tokens)}/${formatTokens(contextWindow)} tokens on ${target.provider}/${target.model}); compacting before the next turn`);
	let result;
	try {
		result = await engine.compactNow(agent, controller.signal);
	} catch (error) {
		const code = error?.code;
		if (error?.name === "ManualCompactionError" && (code === "busy" || code === "cancelled")) {
			ctx.logger.debug(`auto-compact: idle compaction skipped (${code})`);
			return;
		}
		state.lastReport = `failed (${code ?? "error"})`;
		ctx.logger.warn(`auto-compact: idle compaction failed (${code ?? "error"}): ${errorMessage(error)}`);
		return;
	}
	state.above = false;
	if (result === null) {
		state.lastReport = "no compactable history range";
		ctx.logger.debug(`auto-compact: ${state.lastReport} at the idle boundary`);
		return;
	}
	state.lastReport = `compacted ${result.shadowedSeqs.length} items (~${formatTokens(result.shadowedTokenCount)} tokens) while idle`;
	ctx.logger.info(`auto-compact: ${state.lastReport}`);
}
//#endregion
//#region command
/**
 * `/autocompact` — status of threshold, pressure, and the last run.
 *
 * The report re-asserts the policy onto the engine first, so a session whose
 * first step has not run yet (fresh process, adopted session, long idle) shows
 * the threshold the plugin actually applies instead of the engine's stock
 * value. A disabled plugin never touches the engine.
 */
function statusReport(ctx, config, invocation) {
	let settings;
	try {
		settings = resolveSettings(config);
	} catch (error) {
		return { kind: "error", text: `auto-compact configuration is invalid: ${errorMessage(error)}` };
	}
	const lines = ["auto-compact status"];
	lines.push(`  enabled: ${settings.enabled ? "yes" : "no"}`);
	lines.push(`  threshold: ${formatRatio(settings.thresholdRatio)} of the routed model's context window`);
	if (settings.modelPolicies.length > 0) lines.push(`  per-model thresholds: ${settings.modelPolicies.map((policy) => `${policy.provider}/${policy.model} ${formatRatio(policy.thresholdRatio)}`).join(", ")}`);
	if (settings.retainTokens !== undefined) lines.push(`  retention: ${formatTokens(settings.retainTokens)} tokens kept verbatim`);
	else if (settings.retainRatio !== undefined) lines.push(`  retention: ${formatRatio(settings.retainRatio)} of the message budget kept verbatim`);
	const agent = invocation.agent;
	const engine = patchableEngine(engineFor(ctx, agent));
	if (engine === undefined) lines.push("  engine: no compaction engine with a patchable policy is mounted (idle sweep only)");
	else {
		if (settings.enabled) syncEnginePolicy(ctx, engine, settings);
		lines.push(`  engine: policy synced (automatic compaction ${engine.config.auto === true ? "on" : "off"}; active threshold ${formatRatio(engine.config.thresholdRatio)})`);
	}
	if (agent !== undefined) {
		const target = routedTarget(agent);
		const measurement = measurePressure(ctx, agent);
		if (target !== undefined) lines.push(`  route: ${target.provider}/${target.model}`);
		if (measurement !== undefined) lines.push(`  pressure: ${formatTokens(measurement.totalTokens)} tokens`);
		const state = agentStates.get(agent);
		if (state !== undefined && state.lastReport.length > 0) lines.push(`  last run: ${state.lastReport}`);
	}
	return { kind: "success", text: lines.join("\n") };
}
/**
 * Parse the optional threshold argument.
 * @returns `status` for no input, `set` with a ratio in (0, 1), or `invalid`.
 */
function parseThresholdInput(rawInput) {
	const text = rawInput.trim().replace(/%$/u, "");
	if (text.length === 0) return { kind: "status" };
	if (!/^\d+(\.\d+)?$/u.test(text)) return { kind: "invalid" };
	const percent = Number(text);
	if (!(percent > 0 && percent < 100)) return { kind: "invalid" };
	return { kind: "set", ratio: percent / 100 };
}
/**
 * Set the compaction threshold to one percentage of the context window.
 *
 * The value is written through the settings seam into the profile patch — the
 * same path the GUI's plugin config form uses — so it survives restarts and
 * applies live through the volatile config cell. The engine is re-synced
 * immediately so the new threshold governs the very next decision.
 */
async function setThreshold(ctx, config, invocation, ratio) {
	const settings = ctx.get("settings");
	if (!isRecord(settings) || typeof settings.update !== "function") {
		return { kind: "error", text: "auto-compact: no settings service is mounted, so the threshold cannot be persisted; set thresholdRatio in the profile patch instead" };
	}
	let current;
	try {
		current = resolveSettings(config);
	} catch (error) {
		return { kind: "error", text: `auto-compact configuration is invalid: ${errorMessage(error)}` };
	}
	if (current.retainRatio !== undefined && current.retainRatio >= ratio) {
		return { kind: "error", text: `auto-compact: ${formatRatio(ratio)} is not above the configured retainRatio (${formatRatio(current.retainRatio)}); raise the threshold or lower retainRatio` };
	}
	try {
		await settings.update(ENTRY_ID, { thresholdRatio: ratio });
	} catch (error) {
		return { kind: "error", text: `auto-compact: could not persist the threshold: ${errorMessage(error)}` };
	}
	let active;
	try {
		const applied = resolveSettings(config);
		const engine = patchableEngine(engineFor(ctx, invocation.agent));
		if (engine !== undefined && applied.enabled) syncEnginePolicy(ctx, engine, applied);
		active = engine === undefined ? "no engine mounted yet" : formatRatio(engine.config.thresholdRatio);
	} catch (error) {
		active = `applies at the next step (${errorMessage(error)})`;
	}
	return { kind: "success", text: `auto-compact: threshold set to ${formatRatio(ratio)} of the routed model's context window (persisted; engine active threshold ${active})` };
}
/** `/autocompact` dispatcher: status with no input, threshold set with a percent. */
function commandHandler(ctx, config, invocation) {
	const parsed = parseThresholdInput(invocation.rawInput);
	if (parsed.kind === "invalid") return { kind: "error", text: USAGE };
	if (parsed.kind === "status") return statusReport(ctx, config, invocation);
	return setThreshold(ctx, config, invocation, parsed.ratio);
}
//#endregion
//#region apply
/**
 * Mount the auto-compact policy: log the armed threshold, observe every step
 * boundary, sweep at every idle boundary, and register `/autocompact` when a
 * command registry exists.
 * @param ctx - plugin context.
 * @param config - plugin config cells.
 */
function apply(ctx, config) {
	const settings = resolveSettings(config);
	ctx.logger.info(`auto-compact: armed at ${formatRatio(settings.thresholdRatio)} of the routed context window (idle sweep cooldown ${settings.cooldownSeconds}s)`);
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		try {
			if (signal?.aborted !== true) await observePreStep(ctx, config, agent, signal);
		} catch (error) {
			warnOnce(ctx, `auto-compact: pre-step check failed: ${errorMessage(error)}`);
		}
		return next();
	});
	ctx.on("agent/status", ({ agent, status }) => {
		if (status !== "idle") return;
		const state = stateFor(agent);
		if (state.inFlight !== null) return;
		let current;
		try {
			current = resolveSettings(config);
		} catch (error) {
			warnOnce(ctx, `auto-compact: idle sweep skipped, configuration invalid: ${errorMessage(error)}`);
			return;
		}
		if (!current.enabled) return;
		const operation = (async () => {
			try {
				await idleSweep(ctx, current, agent, state);
			} catch (error) {
				warnOnce(ctx, `auto-compact: idle sweep failed: ${errorMessage(error)}`);
			} finally {
				if (state.inFlight === operation) state.inFlight = null;
			}
		})();
		state.inFlight = operation;
	});
	ctx.inject(["commands"], (child) => {
		child.effect(() => child.commands.register({
			definitionId: CommandDefinitionId("dsh-auto-compact"),
			name: COMMAND_NAME,
			description: "Show auto-compact status, or set the threshold: /autocompact [percent]",
			handler: (invocation) => commandHandler(ctx, config, invocation)
		}), "auto-compact command registration");
	});
}
//#endregion
//#region utils
/** Last warning text, so a recurring failure (e.g. an invalid runtime edit) logs once. */
let lastWarning = "";
function warnOnce(ctx, message) {
	if (message === lastWarning) return;
	lastWarning = message;
	ctx.logger.warn(message);
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function formatTokens(tokens) {
	return Math.round(tokens).toLocaleString("en-US");
}
function formatRatio(ratio) {
	const percent = ratio * 100;
	return `${Number.isInteger(percent) ? percent : Number(percent.toFixed(1))}%`;
}
//#endregion
export { COMMAND_NAME, Config, apply, inject, name, resolveSettings };
