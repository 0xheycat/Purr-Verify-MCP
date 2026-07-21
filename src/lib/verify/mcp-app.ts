// Purr Verify MCP App compatibility layer.
//
// The resource/tool-card pattern is adapted from Waishnav/devspace (MIT):
// https://github.com/Waishnav/devspace
// Purr Verify JSON-RPC, OAuth, durable jobs, browser work, and operator runtime
// remain server-side. This module only adds a lightweight self-contained card
// around existing structured tool results.

import type { NextRequest } from "next/server";

export const VERIFY_MCP_APP_URI = "ui://purr/verify-workbench-v8.html";
export const VERIFY_MCP_APP_LEGACY_URIS = Object.freeze([
  "ui://purr/verify-workbench-v7.html",
]);
export const VERIFY_MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

const VERIFY_MCP_APP_READABLE_URIS = new Set([
  VERIFY_MCP_APP_URI,
  ...VERIFY_MCP_APP_LEGACY_URIS,
]);

export const VERIFY_MCP_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["kind", "tool", "status", "isError", "payload"],
  properties: {
    kind: { type: "string", const: "purr-verify-card" },
    tool: { type: "string", minLength: 1 },
    status: { type: "string", minLength: 1 },
    isError: { type: "boolean" },
    payload: {},
  },
});

export interface VerifyMcpAppCard {
  kind: "purr-verify-card";
  tool: string;
  status: string;
  isError: boolean;
  payload: unknown;
}

export function verifyMcpAppToolMeta(toolName: string): Record<string, unknown> | undefined {
  if (!toolName) return undefined;
  return {
    ui: {
      resourceUri: VERIFY_MCP_APP_URI,
      visibility: ["model"],
    },
    "openai/outputTemplate": VERIFY_MCP_APP_URI,
  };
}

export function verifyMcpAppCard(
  tool: string,
  payload: unknown,
  isError = false,
): VerifyMcpAppCard {
  return {
    kind: "purr-verify-card",
    tool,
    status: inferStatus(payload, isError),
    isError,
    payload,
  };
}

export function verifyMcpAppResultMeta(tool: string): Record<string, unknown> {
  return {
    tool,
    card: {
      kind: "purr-verify-card",
      tool,
    },
  };
}

export function listVerifyMcpAppResources() {
  return [
    {
      uri: VERIFY_MCP_APP_URI,
      name: "purr-verify-workbench",
      title: "Purr Verify Workbench",
      description: "Lightweight collapsed cards for every existing Verify MCP tool.",
      mimeType: VERIFY_MCP_APP_MIME_TYPE,
    },
  ];
}

export function readVerifyMcpAppResource(_req: NextRequest, uri: string) {
  if (!VERIFY_MCP_APP_READABLE_URIS.has(uri)) return null;
  return {
    contents: [
      {
        uri,
        mimeType: VERIFY_MCP_APP_MIME_TYPE,
        text: verifyMcpAppHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  };
}

export function decorateVerifyMcpInitialize(json: unknown): unknown {
  forEachPacket(json, (packet) => {
    const result = packet.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const capabilities =
      result.capabilities && typeof result.capabilities === "object" && !Array.isArray(result.capabilities)
        ? (result.capabilities as Record<string, unknown>)
        : {};
    result.capabilities = {
      ...capabilities,
      resources: {
        listChanged: false,
      },
    };
  });
  return json;
}

export function decorateVerifyMcpToolsList(json: unknown): unknown {
  forEachPacket(json, (packet) => {
    const tools = packet.result?.tools;
    if (!Array.isArray(tools)) return;
    for (const entry of tools) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const tool = entry as Record<string, unknown>;
      const name = typeof tool.name === "string" ? tool.name : "";
      tool.outputSchema = VERIFY_MCP_OUTPUT_SCHEMA;
      const meta = verifyMcpAppToolMeta(name);
      if (meta) {
        tool._meta = {
          ...(tool._meta && typeof tool._meta === "object" && !Array.isArray(tool._meta)
            ? (tool._meta as Record<string, unknown>)
            : {}),
          ...meta,
        };
      }
    }
  });
  return json;
}

export function decorateVerifyMcpToolResults(
  json: unknown,
  calls: Array<{ id?: string | number | null; tool?: string }>,
): unknown {
  const toolById = new Map<string, string>();
  let singleTool = "";
  for (const call of calls) {
    if (!call.tool) continue;
    singleTool = call.tool;
    toolById.set(String(call.id ?? "null"), call.tool);
  }
  forEachPacket(json, (packet) => {
    const tool = toolById.get(String(packet.id ?? "null")) || singleTool;
    if (!tool) return;
    const result = packet.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const payload = extractToolPayload(result);
    const isError = result.isError === true;
    result.structuredContent = verifyMcpAppCard(tool, payload, isError);
    result._meta = {
      ...(result._meta && typeof result._meta === "object" && !Array.isArray(result._meta)
        ? (result._meta as Record<string, unknown>)
        : {}),
      ...verifyMcpAppResultMeta(tool),
    };
  });
  return json;
}

interface RpcPacket {
  id?: string | number | null;
  result?: Record<string, unknown>;
}

function forEachPacket(json: unknown, visit: (packet: RpcPacket) => void): void {
  if (Array.isArray(json)) {
    for (const packet of json) {
      if (packet && typeof packet === "object" && !Array.isArray(packet)) visit(packet as RpcPacket);
    }
    return;
  }
  if (json && typeof json === "object") visit(json as RpcPacket);
}

function extractToolPayload(result: Record<string, unknown>): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content;
  if (!Array.isArray(content)) return result;
  const texts = content
    .filter((entry): entry is { type: string; text?: unknown } => {
      return Boolean(entry && typeof entry === "object" && !Array.isArray(entry));
    })
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => String(entry.text));
  if (texts.length === 0) return result;
  const text = texts.join("\n");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

function inferStatus(payload: unknown, isError: boolean): string {
  if (isError) return "failed";
  const status = findString(payload, ["status", "state", "result"]);
  return status || "ready";
}

function findString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 2 || !value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  for (const nested of ["job", "data", "project", "execution", "plan"]) {
    const found = findString(record[nested], keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function verifyMcpAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="mcp-app-template" content="${VERIFY_MCP_APP_URI}">
<title>Purr Verify Workbench</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:CanvasText}body{padding:2px}
.card{border:1px solid color-mix(in srgb,CanvasText 14%,transparent);border-radius:9px;background:Canvas;overflow:hidden;contain:content}
summary{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 10px;cursor:pointer;list-style:none;min-height:44px}
summary::-webkit-details-marker{display:none}.mark{font:700 10px/1 ui-monospace,monospace;color:GrayText;text-align:center}
.main{min-width:0}.title{display:block;font-size:13px;font-weight:650;line-height:1.25}.label{display:block;margin-top:2px;color:GrayText;font:10px/1.3 ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.state{display:flex;align-items:center;gap:5px;color:GrayText;font:10px/1 ui-monospace,monospace;white-space:nowrap}.dot{width:6px;height:6px;border-radius:50%;background:#22c55e}.running .dot{background:#f59e0b}.failed .dot{background:#ef4444}
.body{border-top:1px solid color-mix(in srgb,CanvasText 9%,transparent);padding:9px 10px 10px}.summary{margin:0 0 7px;font-size:12px;line-height:1.4}.rows{margin:0}.row{display:grid;grid-template-columns:92px minmax(0,1fr);gap:9px;padding:4px 0}.row+ .row{border-top:1px solid color-mix(in srgb,CanvasText 7%,transparent)}dt{color:GrayText;font-size:10px}dd{margin:0;font:10px/1.4 ui-monospace,monospace;overflow-wrap:anywhere}
.items{margin:7px 0 0;padding:0;list-style:none}.item{padding:4px 0;font:10px/1.35 ui-monospace,monospace;overflow-wrap:anywhere}.item+ .item{border-top:1px solid color-mix(in srgb,CanvasText 7%,transparent)}
.raw{margin-top:7px}.raw summary{display:block;min-height:0;padding:4px 0;color:GrayText;font:10px/1.2 ui-monospace,monospace}.raw pre{max-height:220px;overflow:auto;margin:4px 0 0;padding:7px;border-radius:6px;background:color-mix(in srgb,CanvasText 6%,transparent);font:10px/1.4 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.empty{padding:9px 10px;color:GrayText;font-size:11px}
</style>
</head>
<body><main id="app"><section class="empty">Waiting for Verify result.</section></main>
<script>
const root=document.querySelector("#app");let card=normalize(window.openai?.toolOutput,window.openai?.toolResponseMetadata);let expanded=false;host(window.openai||{});render();
window.addEventListener("openai:set_globals",event=>{const g=event.detail?.globals||{};host(g);const next=normalize(g.toolOutput??window.openai?.toolOutput,g.toolResponseMetadata??window.openai?.toolResponseMetadata);update(next)},{passive:true});
window.addEventListener("message",event=>{if(event.source!==window.parent)return;const message=event.data;if(message?.jsonrpc!=="2.0"||message.method!=="ui/notifications/tool-result")return;update(normalize(message.params))},{passive:true});
function host(g){if(g.theme)document.documentElement.style.colorScheme=g.theme;const i=g.safeAreaInsets;if(i)document.body.style.padding=i.top+"px "+i.right+"px "+i.bottom+"px "+i.left+"px"}
function update(next){if(!next)return;if(!card||next.tool!==card.tool)expanded=false;card=next;render()}
function normalize(result,metadata){if(!result)return null;const full=result&&typeof result==="object"?result:{};const value=full.structuredContent??result;const meta=full._meta||metadata||{};if(value?.kind==="purr-verify-card")return value;return{kind:"purr-verify-card",tool:meta.tool||meta.card?.tool||"verify",status:value?.status||value?.state||(full.isError?"failed":"ready"),isError:Boolean(full.isError),payload:value?.payload??value}}
function render(){if(!root)return;if(!card){root.innerHTML='<section class="empty">Waiting for Verify result.</section>';return}const view=header(card.tool,card.payload);const details=node("details","card");details.open=expanded;const head=node("summary");head.append(node("span","mark",view.mark),main(view),state(card.status,card.isError));const body=node("div","body");details.append(head,body);details.addEventListener("toggle",()=>{expanded=details.open;if(details.open&&!body.dataset.ready)fill(body,card.payload)});if(expanded)fill(body,card.payload);root.replaceChildren(details)}
function main(view){const span=node("span","main");span.append(node("span","title",view.title));if(view.label)span.append(node("span","label",view.label));return span}
function state(status,isError){const tone=statusTone(status,isError);const span=node("span","state "+tone);span.append(node("span","dot"),node("span","",statusText(status,isError)));return span}
function header(tool,payload){let mark="V",title=sentence(String(tool||"Verify").replaceAll("purr_","").replaceAll("_"," "));if(/health|debug_status/i.test(tool)){mark="H";title="Runtime health"}else if(/job_status|verification_job|latest_verification/i.test(tool)){mark="J";title="Job status"}else if(/verify_project|create_verification/i.test(tool)){mark="✓";title="Verification"}else if(/deploy|rollback|restart/i.test(tool)){mark="D";title="Deployment"}else if(/inspect|discover|plan_deployment/i.test(tool)){mark="I";title="Project inspection"}else if(/work_session|browser/i.test(tool)){mark="B";title="Browser work session"}else if(/run_command/i.test(tool)){mark=">";title="Operator command"}return{mark,title,label:first(payload,["jobId","sessionId","repo","ref","cwd","service","status","message"])}}
function fill(body,payload){body.dataset.ready="1";const summary=first(payload,["message","error","warning","reason","notes"]);if(summary)body.append(node("p","summary",clip(summary,600)));const rows=collectRows(payload);if(rows.length){const dl=node("dl","rows");for(const row of rows){const wrap=node("div","row");wrap.append(node("dt","",row[0]),node("dd","",row[1]));dl.append(wrap)}body.append(dl)}const items=findItems(payload);if(items.length){const ul=node("ul","items");for(const item of items)ul.append(node("li","item",line(item)));body.append(ul)}const raw=node("details","raw");raw.append(node("summary","","Raw preview"));raw.addEventListener("toggle",()=>{if(raw.open&&raw.children.length===1)raw.append(node("pre","",preview(payload)))});body.append(raw)}
function collectRows(payload){const defs=[["Status",["status","state"]],["Job",["jobId"]],["Session",["sessionId"]],["Repository",["repo"]],["Ref",["ref"]],["Project",["cwd","canonicalPath"]],["Service",["service","serviceName"]],["Duration",["durationMs"]]];const out=[];for(const def of defs){const value=first(payload,def[1]);if(value!==undefined&&String(value)!=="")out.push([def[0],clip(value,800)]);if(out.length===6)break}return out}
function first(value,keys){if(!value||typeof value!=="object")return undefined;for(const key of keys){const candidate=value[key];if(["string","number","boolean"].includes(typeof candidate)&&String(candidate)!=="")return candidate}for(const key of ["payload","job","data","project","execution","plan","session","browser"]){const nested=value[key];if(nested&&typeof nested==="object"&&!Array.isArray(nested)){for(const wanted of keys){const candidate=nested[wanted];if(["string","number","boolean"].includes(typeof candidate)&&String(candidate)!=="")return candidate}}}return undefined}
function findItems(value){if(Array.isArray(value))return value.slice(0,6);if(!value||typeof value!=="object")return[];for(const key of ["commands","checks","sessions","entries","results","tools","projects","installStrategies"]){if(Array.isArray(value[key]))return value[key].slice(0,6)}for(const key of ["payload","data","job","project","execution"]){if(value[key]&&typeof value[key]==="object"){const found=findItems(value[key]);if(found.length)return found}}return[]}
function line(value){if(value&&typeof value==="object"){const left=value.command||value.name||value.label||value.repo||value.path||value.sessionId||value.jobId||"item";const right=value.status||value.state||value.exitCode;return clip(String(left)+(right!==undefined?" · "+String(right):""),500)}return clip(String(value),500)}
function preview(value){try{return clip(JSON.stringify(bound(value),null,2),12000)}catch{return clip(String(value),12000)}}
function bound(value,depth=0,state={nodes:0}){if(value===null||typeof value!=="object")return value;if(depth>3||state.nodes>120)return"[truncated]";state.nodes+=1;if(Array.isArray(value))return value.slice(0,8).map(item=>bound(item,depth+1,state));const out={};for(const key of Object.keys(value).slice(0,16))out[key]=bound(value[key],depth+1,state);return out}
function statusText(status,isError){if(isError)return"failed";const value=String(status||"ready").toLowerCase();if(/success|complete|completed|ok|healthy|verified/.test(value))return"ready";if(/manual/.test(value))return"manual required";if(/approval/.test(value))return"approval required";return clip(value,20)}
function statusTone(status,isError){if(isError||/fail|error|cancel|timeout|reject|unavailable/i.test(String(status)))return"failed";if(/run|queue|pending|progress|approval|manual|unknown/i.test(String(status)))return"running";return"ok"}
function sentence(value){const text=String(value||"").trim();return text?text[0].toUpperCase()+text.slice(1):"Verify"}
function clip(value,limit){const text=String(value??"");return text.length>limit?text.slice(0,limit)+"…":text}
function node(tag,className="",text){const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=String(text);return element}
</script></body></html>`;
}
