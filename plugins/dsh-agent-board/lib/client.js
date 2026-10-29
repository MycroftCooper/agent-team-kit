window.__ModuleLoader__.load({
	id: "__PLUGIN_ID__",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		// Plugin identity comes from the project config through `atk plugin sync`.
		const BOARD_ID = "__PLUGIN_ID__";
		const BOARD_KIND = "__PLUGIN_TAB_KIND__";
		const BOARD_TITLE = "__PLUGIN_TITLE__";
		const COMMAND_ID = "__PLUGIN_COMMAND_ID__";
		const API = "__PLUGIN_ROUTE__/api/snapshot";
		const TOGGLE = "__PLUGIN_ROUTE__/api/human-todos/toggle";
		const EVENTS = "__PLUGIN_ROUTE__/api/events";
		const POLL_MS = 30000;
		const LINE = "1px solid rgba(128,128,128,0.32)";
		const MUTED = "rgba(128,128,128,0.95)";

		// The host plugin ships localized labels inside the snapshot; this English
		// dictionary only keeps the panel readable while the first fetch is in flight.
		const STAGE_ORDER = ["in-progress", "blocked", "implemented", "partial", "todo", "proposed", "done"];
		const STAGE_COLOR = {
			"in-progress": "#1f5f8b",
			blocked: "#9b2c2c",
			implemented: "#2f6f4f",
			partial: "#8a5a00",
			todo: "rgba(128,128,128,0.8)",
			proposed: "rgba(128,128,128,0.8)",
			done: "rgba(128,128,128,0.55)",
		};
		const AGENT_COLOR = {
			working: "#1f5f8b",
			waiting: "#8a5a00",
			blocked: "#9b2c2c",
			idle: "rgba(128,128,128,0.7)",
		};
		const FALLBACK = {
			board: {
				agents: "Agents",
				milestones: "Batch milestones",
				humanTodos: "Human-only todos",
				packages: "Active work packages",
				archived: "Completed archive",
				generatedBy: "Generated from state.json",
			},
			columns: { evidence: "Evidence", archivedAt: "Archived at", total: "Total" },
			misc: { none: "none" },
			stage: {},
			slice: {},
			type: {},
		};

		function labelsOf(snapshot) {
			return (snapshot && snapshot.labels) || FALLBACK;
		}

		function b(labels, key) {
			var value = (labels.board || {})[key];
			return typeof value === "string" && value !== "" ? value : (FALLBACK.board[key] || key);
		}

		function stageText(labels, stage) {
			return (labels.stage || {})[stage] || stage;
		}

		function sliceText(labels, status) {
			return (labels.slice || {})[status] || status;
		}

		function typeText(labels, type) {
			return (labels.type || {})[type] || type;
		}

		function agentText(labels, status) {
			return (labels.agentStatus || {})[status] || status || "";
		}

		function columnText(labels, key) {
			var value = (labels.columns || {})[key];
			return typeof value === "string" && value !== "" ? value : (FALLBACK.columns[key] || key);
		}

		function noneText(labels) {
			var value = (labels.misc || {}).none;
			return typeof value === "string" && value !== "" ? value : FALLBACK.misc.none;
		}

		function fmtTime(iso) {
			if (!iso) return "-";
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return String(iso);
			return date.toLocaleString();
		}

		/** Pure view: only needs a snapshot, so it can be tested without the host. */
		function BoardView({ snapshot, status, error, onToggle }) {
			if (!snapshot) {
				return h(
					"div",
					{ style: { padding: 12, fontSize: 12, color: MUTED, fontFamily: "inherit" } },
					status === "error"
						? "Board data unavailable: " + (error || "unknown error") +
							" (check that the host board plugin is enabled and state.json exists)"
						: "Loading board data...",
				);
			}
			const labels = labelsOf(snapshot);
			const counts = snapshot.counts || { byStage: {}, total: 0 };
			const agents = snapshot.agents || [];
			const milestones = snapshot.milestones || [];
			const packages = snapshot.packages || [];
			const todos = snapshot.humanTodos || [];
			const archived = snapshot.archived || [];

			const style = {
				padding: "10px 12px 24px",
				fontFamily: "inherit",
				fontSize: 12,
				lineHeight: 1.45,
				color: "inherit",
				overflowY: "auto",
				height: "100%",
				boxSizing: "border-box",
			};
			const sectionTitle = { fontSize: 11, letterSpacing: "0.06em", color: MUTED, margin: "14px 0 6px" };
			const card = {
				border: LINE,
				borderRadius: 6,
				padding: "6px 8px",
				marginBottom: 6,
				background: "rgba(128,128,128,0.05)",
			};

			return h(
				"div",
				{ style },
				h(
					"div",
					{ style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
					h("strong", { style: { fontSize: 13 } }, snapshot.title || BOARD_TITLE),
					h("span", { style: { color: MUTED } }, snapshot.batch ? snapshot.batch.id : ""),
					h("span", { style: { marginLeft: "auto", color: MUTED, fontSize: 11 } }, fmtTime(snapshot.generatedAt)),
				),
				h(
					"div",
					{ style: { color: MUTED, fontSize: 11, marginTop: 2 } },
					(status === "stale" ? "Stale data - " : "") +
						b(labels, "packages") + " " + packages.length + "/" + (counts.total || 0),
				),

				h("div", { style: sectionTitle }, b(labels, "agents")),
				...agents.map((agent) =>
					h(
						"div",
						{ key: "agent-" + agent.role, style: card, title: agent.detail || "" },
						h(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: 6 } },
							h("span", {
								style: {
									width: 7,
									height: 7,
									borderRadius: "50%",
									background: AGENT_COLOR[agent.status] || AGENT_COLOR.idle,
									flex: "0 0 auto",
								},
							}),
							h("strong", null, agent.role),
							h("span", { style: { color: MUTED, fontSize: 11 } }, agentText(labels, agent.status)),
						),
						h("div", { style: { marginTop: 2, fontWeight: 600 } }, agent.task || "-"),
						agent.detail ? h("div", { style: { color: MUTED, fontSize: 11, marginTop: 1 } }, agent.detail) : null,
					),
				),
				agents.length ? null : h("div", { style: { color: MUTED, fontSize: 11 } }, noneText(labels)),

				h("div", { style: sectionTitle }, b(labels, "milestones")),
				h(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", gap: 6 } },
					...milestones.map((ms) =>
						h(
							"span",
							{
								key: "ms-" + ms.id,
								title: ms.note || "",
								style: {
									...card,
									marginBottom: 0,
									display: "inline-flex",
									alignItems: "center",
									gap: 5,
									fontSize: 11,
								},
							},
							h("span", {
								style: {
									width: 6,
									height: 6,
									borderRadius: "50%",
									background: STAGE_COLOR[ms.status] || "rgba(128,128,128,0.7)",
								},
							}),
							ms.label || ms.id,
							h("span", { style: { color: MUTED } }, "- " + sliceText(labels, ms.status)),
						),
					),
				),
				milestones.length ? null : h("div", { style: { color: MUTED, fontSize: 11 } }, noneText(labels)),

				h("div", { style: sectionTitle }, b(labels, "humanTodos")),
				...todos.map((todo) =>
					h(
						"label",
						{
							key: "todo-" + todo.id,
							title: todo.note || "",
							style: {
								...card,
								padding: "5px 7px",
								display: "flex",
								gap: 8,
								alignItems: "baseline",
								cursor: "pointer",
							},
						},
						h("input", {
							type: "checkbox",
							checked: Boolean(todo.done),
							onChange: () => onToggle && onToggle(todo.id),
							style: { margin: 0 },
						}),
						h(
							"span",
							{
								style: {
									flex: "1 1 auto",
									textDecoration: todo.done ? "line-through" : "none",
									color: todo.done ? MUTED : "inherit",
								},
							},
							todo.text,
						),
						h("span", { style: { color: MUTED, fontSize: 10, whiteSpace: "nowrap" } }, todo.id),
					),
				),
				todos.length ? null : h("div", { style: { color: MUTED, fontSize: 11 } }, noneText(labels)),

				...STAGE_ORDER.map((stage) => {
					const items = packages.filter((pkg) => pkg.stage === stage);
					if (!items.length) return null;
					return h(
						"div",
						{ key: "stage-" + stage },
						h(
							"div",
							{ style: sectionTitle },
							h("span", {
								style: {
									display: "inline-block",
									width: 6,
									height: 6,
									borderRadius: 2,
									marginRight: 6,
									background: STAGE_COLOR[stage],
								},
							}),
							stageText(labels, stage) + " " + items.length,
						),
						...items.map((pkg) =>
							h(
								"div",
								{ key: pkg.id, style: { ...card, padding: "5px 7px" }, title: pkg.note || "" },
								h(
									"div",
									{ style: { display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" } },
									h("strong", { style: { fontSize: 12 } }, pkg.id),
									pkg.type ? h("span", { style: { color: MUTED, fontSize: 10 } }, typeText(labels, pkg.type)) : null,
									pkg.priority ? h("span", { style: { color: MUTED, fontSize: 10 } }, pkg.priority) : null,
									h("span", { style: { marginLeft: "auto", color: MUTED, fontSize: 10 } }, pkg.owner || ""),
								),
							),
						),
					);
				}),

				h("div", { style: { ...sectionTitle, marginTop: 16 } }, b(labels, "archived")),
				...archived.map((pkg) =>
					h(
						"div",
						{ key: "arch-" + pkg.id, style: { ...card, padding: "5px 7px" }, title: pkg.note || "" },
						h(
							"div",
							{ style: { display: "flex", gap: 6, alignItems: "baseline" } },
							h("strong", { style: { fontSize: 12 } }, pkg.id),
							h("span", { style: { marginLeft: "auto", color: MUTED, fontSize: 10 } }, fmtTime(pkg.archivedAt)),
						),
						h(
							"div",
							{ style: { color: MUTED, fontSize: 10, marginTop: 1 } },
							pkg.archiveReason || noneText(labels),
						),
					),
				),
				archived.length ? null : h("div", { style: { color: MUTED, fontSize: 11 } }, noneText(labels)),

				h(
					"div",
					{ style: { ...sectionTitle, marginTop: 18 } },
					b(labels, "generatedBy") + " - " + columnText(labels, "total") + " " + (counts.total || 0),
				),
			);
		}

		function useSnapshot() {
			const [state, setState] = react.useState({ status: "loading", snapshot: null, error: null });
			const [nonce, setNonce] = react.useState(0);
			react.useEffect(() => {
				let alive = true;
				const load = async () => {
					try {
						const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
						const body = await response.json().catch(() => ({}));
						if (!response.ok) throw new Error(body.error || "HTTP " + response.status);
						if (alive) setState({ status: "ready", snapshot: body, error: null });
					} catch (error) {
						if (!alive) return;
						setState((previous) => ({
							status: previous.snapshot ? "stale" : "error",
							snapshot: previous.snapshot,
							error: String(error && error.message ? error.message : error),
						}));
					}
				};
				load();
				let source;
				let timer;
				const startPolling = () => {
					if (timer) return;
					timer = setInterval(() => {
						if (typeof document === "undefined" || !document.hidden) load();
					}, POLL_MS);
				};
				if (typeof window !== "undefined" && window.EventSource) {
					source = new window.EventSource(EVENTS);
					source.onmessage = () => {
						if (typeof document === "undefined" || !document.hidden) load();
					};
					source.onerror = startPolling;
					if (typeof document !== "undefined") {
						document.addEventListener("visibilitychange", () => {
							if (!document.hidden) load();
						});
					}
				} else {
					startPolling();
				}
				return () => {
					alive = false;
					if (source) source.close();
					if (timer) clearInterval(timer);
				};
			}, [nonce]);
			return { ...state, reload: () => setNonce((value) => value + 1) };
		}

		function BoardBody() {
			const { status, snapshot, error, reload } = useSnapshot();
			const onToggle = react.useCallback(
				async (id) => {
					try {
						await fetch(TOGGLE, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ id }),
							credentials: "same-origin",
						});
					} finally {
						reload();
					}
				},
				[reload],
			);
			return h(BoardView, { snapshot, status, error, onToggle });
		}

		function BoardTitle() {
			return h("span", { style: { fontSize: 12 } }, BOARD_TITLE);
		}

		function BoardIcon() {
			return h(
				"svg",
				{ width: 14, height: 14, viewBox: "0 0 16 16", "aria-hidden": "true", fill: "currentColor" },
				h("rect", { x: 1, y: 1, width: 4, height: 6, rx: 1 }),
				h("rect", { x: 6, y: 1, width: 4, height: 9, rx: 1, opacity: 0.75 }),
				h("rect", { x: 11, y: 1, width: 4, height: 4, rx: 1, opacity: 0.55 }),
			);
		}

		/** Required services: slot registry + right sidebar tab type + sidebar nav. */
		const inject = ["slots", "sidebarRightTabs", "sidebarRight"];

		function openBoard(ctx, target) {
			if (target !== undefined && typeof ctx.sidebarRight.openTabFromTarget === "function") {
				ctx.sidebarRight.openTabFromTarget(BOARD_KIND, target);
				return;
			}
			ctx.sidebarRight.openTab(BOARD_KIND);
		}

		function apply(ctx) {
			// A guide entry only shows up when it has a command, so register one first.
			ctx.inject(["shortcuts"], (ctx) => {
				ctx.effect(
					() =>
						ctx.shortcuts.register({
							id: COMMAND_ID,
							label: () => BOARD_TITLE,
							aliases: ["agent board", "workflow board", "board"],
							regions: ["page", "editable", "terminal"],
							modals: [],
							resolve: ({ target: element }) => {
								const target =
									typeof ctx.sidebarRight.commandTarget === "function"
										? ctx.sidebarRight.commandTarget(element)
										: undefined;
								return {
									status: "handled",
									run: () => {
										try {
											openBoard(ctx, target);
										} catch {
											ctx.sidebarRight.openTab(BOARD_KIND);
										}
									},
								};
							},
						}),
					"board: shortcut",
				);
			});
			ctx.effect(
				() =>
					ctx.sidebarRightTabs.register({
						id: BOARD_ID,
						kind: BOARD_KIND,
						priority: "builtin",
						title: () => BOARD_TITLE,
						guide: [
							{
								id: BOARD_ID,
								commandId: COMMAND_ID,
								order: 5,
								title: () => BOARD_TITLE,
								description: () => "Task status and agent activity",
								icon: BoardIcon,
							},
						],
					}),
				"board: tab type",
			);
			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.right.pane.tab", () =>
						ctx.slots.register({ name: "sidebar.right.pane.tab", key: BOARD_ID }, BoardBody),
					),
				"board: tab body",
			);
			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.right.pane.tab.title", () =>
						ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: BOARD_ID }, BoardTitle),
					),
				"board: tab title",
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.BoardView = BoardView;
		return module.exports;
	},
});
