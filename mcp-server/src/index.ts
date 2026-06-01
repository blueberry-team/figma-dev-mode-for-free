import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

const WS_PORT = parseInt(process.env.MCP_BRIDGE_PORT ?? '3055', 10);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type FigmaComment = {
  id: string;
  message: string;
  created_at: string;
  resolved_at?: string | null;
  parent_id?: string;
  user: { handle: string; id: string };
  client_meta: { node_id?: string; node_offset?: { x: number; y: number }; x?: number; y?: number } | null;
  order_id?: string;
  reactions?: unknown[];
};

// ─── WebSocket Bridge ─────────────────────────────────────────────────────────

let figmaPlugin: WebSocket | null = null;

const pending = new Map<
  string,
  { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

const wss = new WebSocketServer({ port: WS_PORT });

wss.on('listening', () => {
  log(`WebSocket bridge listening on ws://localhost:${WS_PORT}`);
});

wss.on('connection', (ws) => {
  log('Figma plugin connected');
  figmaPlugin = ws;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        requestId?: string;
        data?: unknown;
        error?: string;
      };

      if (msg.requestId && pending.has(msg.requestId)) {
        const entry = pending.get(msg.requestId)!;
        clearTimeout(entry.timer);
        pending.delete(msg.requestId);

        if (msg.error) {
          entry.reject(new Error(msg.error));
        } else {
          entry.resolve(msg.data);
        }
      }
    } catch (e) {
      log(`Parse error: ${e}`);
    }
  });

  ws.on('close', () => {
    log('Figma plugin disconnected');
    figmaPlugin = null;
    // Reject all pending requests
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Figma plugin disconnected'));
      pending.delete(id);
    }
  });

  ws.on('error', (e) => log(`Plugin WS error: ${e}`));
});

wss.on('error', (e) => log(`WS server error: ${e}`));

function sendToFigma(type: string, payload?: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!figmaPlugin || figmaPlugin.readyState !== WebSocket.OPEN) {
      reject(
        new McpError(
          ErrorCode.InternalError,
          'Figma 플러그인이 연결되어 있지 않습니다. Figma를 열고 MCP Bridge 플러그인을 실행해주세요.'
        )
      );
      return;
    }

    const requestId = randomUUID();
    const timer = setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new McpError(ErrorCode.InternalError, `요청 시간 초과 (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timer });
    try {
      figmaPlugin.send(JSON.stringify({ type, payload, requestId }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(new McpError(ErrorCode.InternalError, `WebSocket 전송 실패: ${e}`));
    }
  });
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'figma-mcp-bridge', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'figma_get_selection',
      description:
        '현재 Figma에서 선택된 노드들의 디자인 스펙을 반환합니다. ' +
        'detail 수준에 따라 반환 정보량이 달라집니다. ' +
        'minimal=id/name/type/size만, standard=레이아웃/색상/타이포 포함, full=boundVariables/componentProperties/overrides 등 모든 속성. ' +
        '노드 수가 많으면 자동으로 깊은 자식의 detail이 줄어듭니다.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          maxDepth: {
            type: 'number',
            description: '자식 노드 탐색 최대 깊이 (기본값: 5)',
            default: 5,
          },
          detail: {
            type: 'string',
            enum: ['minimal', 'standard', 'full'],
            description: '직렬화 상세 수준 (기본값: standard). minimal=id/name/type/size, standard=레이아웃/색상/타이포, full=boundVariables/componentProperties/overrides/styledSegments 등 전체',
            default: 'standard',
          },
        },
      },
    },
    {
      name: 'figma_get_node',
      description:
        '특정 노드 ID로 Figma 노드의 디자인 스펙을 가져옵니다. ' +
        'URL의 node-id 파라미터(예: 123:456)를 사용하세요. ' +
        'PAGE 노드도 지원합니다 (최상위 프레임 목록 반환). ' +
        'detail=full이면 boundVariables, componentProperties, styledSegments 등을 포함합니다. ' +
        '널값/빈배열/기본값(visible:true, opacity:1 등)은 자동 제거됩니다.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          nodeId: {
            type: 'string',
            description: 'Figma 노드 ID (예: "123:456" 또는 "1234:5678")',
          },
          maxDepth: {
            type: 'number',
            description: '자식 노드 탐색 최대 깊이 (기본값: 5)',
            default: 5,
          },
          detail: {
            type: 'string',
            enum: ['minimal', 'standard', 'full'],
            description: '직렬화 상세 수준 (기본값: standard). minimal=id/name/type/size, standard=레이아웃/색상/타이포, full=전체 속성 포함',
            default: 'standard',
          },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'figma_get_page_nodes',
      description:
        '현재 Figma 페이지의 모든 최상위 노드 목록을 가져옵니다. ' +
        '노드가 30개를 초과하면 경고와 함께 응답합니다. 이 경우 detail:"minimal"로 변경하거나, 특정 노드를 figma_get_node로 직접 조회하여 범위를 줄여주세요.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          maxDepth: {
            type: 'number',
            description: '자식 탐색 깊이 (기본값: 3, 큰 파일은 낮게 설정)',
            default: 3,
          },
          detail: {
            type: 'string',
            enum: ['minimal', 'standard', 'full'],
            description: '직렬화 상세 수준 (기본값: standard)',
            default: 'standard',
          },
        },
      },
    },
    {
      name: 'figma_get_page_full',
      description:
        '현재 Figma 페이지의 모든 노드를 깊이 제한 없이 full detail로 한 번에 직렬화합니다. ' +
        '자동 강등(detail 축소)을 우회하므로 "페이지 전체를 빠짐없이" 가져옵니다. ' +
        '응답이 거대해지는 것을 막기 위해 전체 JSON은 로컬 파일로 저장되고, ' +
        'MCP 응답으로는 저장 경로 + 구조 요약(총 노드 수, 타입별 개수, 최대 깊이, 파일 크기, 최상위 프레임 목록)만 반환합니다. ' +
        '함께 navigator(맵) JSON도 저장합니다: 컨테이너(SECTION/FRAME/COMPONENT/INSTANCE/GROUP 등)와 TEXT만 남기고 ' +
        '순수 그래픽 리프(VECTOR/RECTANGLE 등)는 접어서, AI가 한 번에 읽고 전체 구조를 파악한 뒤 ' +
        '필요한 노드만 figma_get_node(detail:"full")로 순차 조회할 수 있게 합니다. ' +
        '전체 데이터가 필요하면 savedTo 경로를, 구조 파악은 navigatorSavedTo 경로를 Read 하세요.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: {
            type: 'string',
            description: '저장 디렉터리 (미지정 시 FIGMA_DUMP_DIR 환경변수, 없으면 OS 임시폴더의 figma-dumps)',
          },
          detail: {
            type: 'string',
            enum: ['standard', 'full'],
            description: '직렬화 상세 수준 (기본값: full)',
            default: 'full',
          },
          maxDepth: {
            type: 'number',
            description: '최대 탐색 깊이 (기본값: 100 = 사실상 무제한)',
            default: 100,
          },
          navigator: {
            type: 'boolean',
            description: 'navigator(맵) JSON도 함께 저장할지 (기본값: true)',
            default: true,
          },
        },
      },
    },
    {
      name: 'figma_get_file_info',
      description: '현재 열린 Figma 파일 정보 (파일명, 페이지 목록, 현재 페이지, 선택 개수)를 반환합니다.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'figma_get_comments',
      description:
        'Figma 파일의 모든 댓글(코멘트)을 가져옵니다. ' +
        '수정 요청사항, 디자인 피드백, 미해결 이슈를 포함합니다. ' +
        '각 댓글에는 작성자, 내용, 위치, 해결 여부가 포함됩니다. ' +
        'fileKey는 Figma URL에서 추출: https://www.figma.com/design/<fileKey>/...',
      inputSchema: {
        type: 'object' as const,
        properties: {
          fileKey: {
            type: 'string',
            description: 'Figma 파일 키 (URL에서 추출, 예: "serk1hEoUWgx1bvtaR3Lxc"). 미입력 시 현재 열린 파일에서 자동 감지 시도.',
          },
          unresolvedOnly: {
            type: 'boolean',
            description: 'true이면 미해결 댓글만 반환 (기본값: false)',
            default: false,
          },
        },
      },
    },
    {
      name: 'figma_export_node',
      description:
        'Figma 노드를 PNG/SVG/JPG로 내보냅니다. ' +
        'outputDir를 지정하면 실제 파일로 저장하고 저장 경로를 반환합니다(이미지 에셋 추출용). ' +
        'outputDir 미지정 시 PNG/JPG는 base64 이미지, SVG는 텍스트로 반환.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          nodeId: {
            type: 'string',
            description: 'Figma 노드 ID',
          },
          format: {
            type: 'string',
            enum: ['PNG', 'SVG', 'JPG'],
            description: '내보내기 포맷 (기본값: PNG)',
            default: 'PNG',
          },
          scale: {
            type: 'number',
            description: '배율 (기본값: 2 = @2x)',
            default: 2,
          },
          outputDir: {
            type: 'string',
            description: '저장 디렉터리. 지정 시 파일로 저장하고 {savedTo} 경로를 반환합니다. 프로젝트 assets 경로 등 지정.',
          },
          fileName: {
            type: 'string',
            description: '저장 파일명(확장자 제외). 미지정 시 node-<id>로 자동 생성. outputDir와 함께 사용.',
          },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'figma_reply_comment',
      description:
        'Figma 댓글에 답글을 답니다. ' +
        '수정 사항을 답글로 남깁니다. 해결 완료(resolve) 처리는 Figma 공개 API 미지원으로 UI에서 직접 해주세요. ' +
        'fileKey는 Figma URL에서 추출: https://www.figma.com/design/<fileKey>/...',
      inputSchema: {
        type: 'object' as const,
        properties: {
          fileKey: {
            type: 'string',
            description: 'Figma 파일 키 (URL에서 추출)',
          },
          commentId: {
            type: 'string',
            description: '답글을 달 댓글 ID',
          },
          message: {
            type: 'string',
            description: '답글 내용 (수정 완료 내역 등)',
          },
        },
        required: ['fileKey', 'commentId', 'message'],
      },
    },
    {
      name: 'figma_get_styles',
      description:
        'Figma 파일에 정의된 로컬 디자인 시스템 스타일을 모두 가져옵니다. ' +
        '색상 팔레트, 텍스트 스타일, 이펙트 스타일 포함.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'figma_analyze_comments',
      description:
        '미해결 댓글을 조회하고, 각 댓글이 위치한 노드의 디자인 스펙을 함께 반환합니다. ' +
        '한 번의 호출로 "어디에 어떤 문제가 있는지"를 파악할 수 있습니다. ' +
        '노드 정보는 기본적으로 minimal로 가져오며, 특정 노드를 상세히 보려면 figma_get_node로 재조회하세요. ' +
        'fileKey는 Figma URL에서 추출: https://www.figma.com/design/<fileKey>/...',
      inputSchema: {
        type: 'object' as const,
        properties: {
          fileKey: {
            type: 'string',
            description: 'Figma 파일 키 (URL에서 추출). 미입력 시 자동 감지.',
          },
          detail: {
            type: 'string',
            enum: ['minimal', 'standard'],
            description: '노드 정보 상세 수준 (기본값: minimal). 댓글이 많을 경우 minimal 권장.',
            default: 'minimal',
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'figma_get_selection': {
        const data = await sendToFigma('get_selection', {
          maxDepth: clamp(Number(args.maxDepth) || 5, 0, 10),
          detail: args.detail ?? 'standard',
        });
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }

      case 'figma_get_node': {
        if (!args.nodeId) throw new McpError(ErrorCode.InvalidParams, 'nodeId가 필요합니다');
        const data = await sendToFigma('get_node', {
          nodeId: args.nodeId as string,
          maxDepth: clamp(Number(args.maxDepth) || 5, 0, 10),
          detail: args.detail ?? 'standard',
        });
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }

      case 'figma_get_page_nodes': {
        const data = await sendToFigma('get_page_nodes', {
          maxDepth: clamp(Number(args.maxDepth) || 3, 0, 10),
          detail: args.detail ?? 'standard',
        });
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }

      case 'figma_get_page_full': {
        const detail = (args.detail as string) ?? 'full';
        const maxDepth = clamp(Number(args.maxDepth) || 100, 1, 200);
        // 전체 페이지 직렬화는 무거울 수 있으므로 타임아웃을 넉넉히
        const data = (await sendToFigma(
          'get_page_full',
          { detail, maxDepth },
          120_000
        )) as {
          pageId: string;
          pageName: string;
          topLevelCount: number;
          detail: string;
          nodes: Array<Record<string, unknown>>;
        };

        // 트리를 순회하며 요약 통계 계산
        const byType: Record<string, number> = {};
        let totalNodes = 0;
        let maxDepthReached = 0;
        const walk = (node: Record<string, unknown>, d: number) => {
          totalNodes++;
          if (d > maxDepthReached) maxDepthReached = d;
          const t = node.type as string | undefined;
          if (t) byType[t] = (byType[t] ?? 0) + 1;
          const children = node.children;
          if (Array.isArray(children)) {
            for (const c of children) walk(c as Record<string, unknown>, d + 1);
          }
        };
        for (const n of data.nodes) walk(n, 0);

        const topLevel = data.nodes.map((n) => ({
          id: n.id,
          name: n.name,
          type: n.type,
          width: n.width,
          height: n.height,
        }));

        // 전체 JSON을 파일로 저장
        const json = JSON.stringify(data, null, 2);
        const dir =
          (args.outputDir as string) ||
          process.env.FIGMA_DUMP_DIR ||
          path.join(os.tmpdir(), 'figma-dumps');
        await fs.mkdir(dir, { recursive: true });
        const safeName = (data.pageName || 'page')
          .replace(/[^a-zA-Z0-9가-힣_-]+/g, '_')
          .slice(0, 50);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = path.join(dir, `page-${safeName}-${stamp}.json`);
        await fs.writeFile(filePath, json, 'utf8');

        // ── navigator(맵) 생성: 컨테이너 + TEXT만 남기고 그래픽 리프는 접음 ──
        const wantNavigator = args.navigator !== false;
        let navigatorSavedTo: string | undefined;
        let navigatorNodes = 0;
        let navigatorSizeBytes = 0;
        if (wantNavigator) {
          const CONTAINER = new Set([
            'SECTION', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'SLOT',
          ]);
          // 접힌(그래픽) 서브트리를 타입별 개수로 집계
          const countSubtree = (node: Record<string, unknown>, acc: Record<string, number>) => {
            const t = node.type as string;
            acc[t] = (acc[t] ?? 0) + 1;
            const ch = node.children;
            if (Array.isArray(ch)) for (const c of ch) countSubtree(c as Record<string, unknown>, acc);
          };
          const buildNav = (
            node: Record<string, unknown>,
            d: number
          ): Record<string, unknown> | null => {
            const t = node.type as string;
            const isContainer = CONTAINER.has(t);
            const isText = t === 'TEXT';
            if (!isContainer && !isText) return null; // 그래픽 리프는 접음
            navigatorNodes++;
            const entry: Record<string, unknown> = { id: node.id, name: node.name, type: t, depth: d };
            if (isText && typeof node.characters === 'string') {
              const chars = node.characters as string;
              entry.text = chars.length > 80 ? chars.slice(0, 80) + '…' : chars;
            }
            const children = Array.isArray(node.children) ? (node.children as Record<string, unknown>[]) : [];
            if (children.length) {
              entry.childCount = children.length;
              const navChildren: Record<string, unknown>[] = [];
              const collapsed: Record<string, number> = {};
              for (const c of children) {
                const cn = buildNav(c, d + 1);
                if (cn) navChildren.push(cn);
                else countSubtree(c, collapsed);
              }
              if (navChildren.length) entry.children = navChildren;
              if (Object.keys(collapsed).length) entry.collapsedLeaves = collapsed;
            }
            return entry;
          };
          const navNodes = data.nodes.map((n) => buildNav(n, 0)).filter(Boolean);
          const navData = {
            pageId: data.pageId,
            pageName: data.pageName,
            fullDump: filePath,
            legend: '컨테이너 + TEXT만 포함. 그래픽 리프는 부모의 collapsedLeaves에 타입별 개수로 요약됨. 상세는 id로 figma_get_node(detail:"full") 호출.',
            nodes: navNodes,
          };
          const navJson = JSON.stringify(navData, null, 2);
          navigatorSavedTo = path.join(dir, `nav-${safeName}-${stamp}.json`);
          await fs.writeFile(navigatorSavedTo, navJson, 'utf8');
          navigatorSizeBytes = Buffer.byteLength(navJson, 'utf8');
        }

        const summary = {
          savedTo: filePath,
          navigatorSavedTo,
          pageId: data.pageId,
          pageName: data.pageName,
          detail: data.detail,
          totalNodes,
          navigatorNodes,
          topLevelCount: data.topLevelCount,
          maxDepthReached,
          byType,
          fileSizeBytes: Buffer.byteLength(json, 'utf8'),
          navigatorSizeBytes,
          topLevel,
          hint: '전체 데이터는 savedTo, 구조 파악용 맵은 navigatorSavedTo 경로의 JSON에 있습니다. 먼저 navigator를 Read로 읽어 전체 구조를 파악한 뒤, 구현할 노드 id를 figma_get_node(detail:"full")로 순차 조회하세요.',
        };

        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
      }

      case 'figma_get_file_info': {
        const data = await sendToFigma('get_file_info');
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }

      case 'figma_get_comments': {
        const apiToken = process.env.FIGMA_API_TOKEN;
        if (!apiToken) {
          throw new McpError(ErrorCode.InternalError, 'FIGMA_API_TOKEN 환경변수가 설정되지 않았습니다. MCP 서버 설정에 env.FIGMA_API_TOKEN을 추가해주세요.');
        }

        // Use provided fileKey, or try to get it from the plugin
        let resolvedFileKey = args.fileKey as string | undefined;
        if (!resolvedFileKey) {
          const fileInfo = await sendToFigma('get_file_info') as { fileKey?: string };
          resolvedFileKey = fileInfo.fileKey;
        }
        if (!resolvedFileKey) {
          throw new McpError(
            ErrorCode.InternalError,
            'Figma 파일 키를 가져올 수 없습니다. fileKey 파라미터에 Figma URL의 파일 키를 직접 전달해주세요.\n' +
            '예: https://www.figma.com/design/<fileKey>/... 에서 <fileKey> 부분'
          );
        }
        const fileKey = resolvedFileKey;

        // Fetch comments via Figma REST API
        const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/comments`, {
          headers: { 'X-Figma-Token': apiToken },
        });
        if (!res.ok) {
          throw new McpError(ErrorCode.InternalError, `Figma API 오류: ${res.status} ${res.statusText}`);
        }

        const data = await res.json() as { comments: FigmaComment[] };

        let comments = data.comments.map((c) => ({
          id: c.id,
          message: c.message,
          author: c.user?.handle ?? 'Unknown',
          createdAt: c.created_at,
          resolved: c.resolved_at != null,
          resolvedAt: c.resolved_at ?? null,
          position: c.client_meta,
          reactions: c.reactions ?? [],
        }));

        if (args.unresolvedOnly) {
          comments = comments.filter((c) => !c.resolved);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ count: comments.length, comments }) }] };
      }

      case 'figma_export_node': {
        if (!args.nodeId) throw new McpError(ErrorCode.InvalidParams, 'nodeId가 필요합니다');
        const exportFormat = (args.format as string)?.toUpperCase() ?? 'PNG';
        const data = (await sendToFigma(
          'export_node',
          {
            nodeId: args.nodeId as string,
            format: exportFormat,
            scale: clamp(Number(args.scale) || 2, 0.5, 4),
          },
          60_000 // 60s timeout for exports
        )) as { base64: string; format: string };

        // outputDir 지정 시: 실제 파일로 저장하고 경로 반환 (에셋 추출용)
        if (args.outputDir) {
          const dir = args.outputDir as string;
          await fs.mkdir(dir, { recursive: true });
          const ext = data.format.toLowerCase();
          const safeId = String(args.nodeId).replace(/[^a-zA-Z0-9_-]/g, '-');
          const base = (args.fileName as string) || `node-${safeId}`;
          const filePath = path.join(dir, `${base}.${ext}`);
          // SVG는 base64→utf8 텍스트, PNG/JPG는 base64→바이너리
          const buf = data.format === 'SVG'
            ? Buffer.from(Buffer.from(data.base64, 'base64').toString('utf-8'), 'utf-8')
            : Buffer.from(data.base64, 'base64');
          await fs.writeFile(filePath, buf);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ savedTo: filePath, format: data.format, bytes: buf.length }),
            }],
          };
        }

        // SVG는 텍스트 기반이므로 base64 디코딩 후 텍스트로 반환
        // (Claude API가 SVG를 image로 처리하지 못함)
        if (data.format === 'SVG') {
          const svgText = Buffer.from(data.base64, 'base64').toString('utf-8');
          return {
            content: [{ type: 'text', text: svgText }],
          };
        }

        const mimeMap: Record<string, string> = {
          PNG: 'image/png',
          JPG: 'image/jpeg',
        };

        return {
          content: [
            {
              type: 'image',
              data: data.base64,
              mimeType: mimeMap[data.format] ?? 'image/png',
            },
          ],
        };
      }

      case 'figma_reply_comment': {
        const apiToken = process.env.FIGMA_API_TOKEN;
        if (!apiToken) {
          throw new McpError(ErrorCode.InternalError, 'FIGMA_API_TOKEN 환경변수가 설정되지 않았습니다.');
        }
        if (!args.fileKey) throw new McpError(ErrorCode.InvalidParams, 'fileKey가 필요합니다');
        if (!args.commentId) throw new McpError(ErrorCode.InvalidParams, 'commentId가 필요합니다');
        if (!args.message) throw new McpError(ErrorCode.InvalidParams, 'message가 필요합니다');

        const headers = { 'X-Figma-Token': apiToken, 'Content-Type': 'application/json' };

        // 1. 답글 달기
        const replyRes = await fetch(`https://api.figma.com/v1/files/${args.fileKey}/comments`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ message: `[AI 자동수정] ${args.message}`, comment_id: args.commentId }),
        });
        if (!replyRes.ok) {
          const text = await replyRes.text();
          throw new McpError(ErrorCode.InternalError, `답글 실패: ${replyRes.status} ${text}`);
        }
        const replyData = await replyRes.json() as { id: string };

        // Note: Figma 공개 REST API에는 타인 댓글을 resolve하는 엔드포인트가 없습니다.
        // 해결 완료 처리는 Figma UI에서 직접 해주세요.

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              replyId: replyData.id,
              message: '답글을 달았습니다. 해결 완료 처리는 Figma UI에서 직접 해주세요.',
            }),
          }],
        };
      }

      case 'figma_get_styles': {
        const data = await sendToFigma('get_styles');
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }

      case 'figma_analyze_comments': {
        const apiToken = process.env.FIGMA_API_TOKEN;
        if (!apiToken) {
          throw new McpError(ErrorCode.InternalError, 'FIGMA_API_TOKEN 환경변수가 설정되지 않았습니다.');
        }

        // Resolve fileKey
        let resolvedFileKey = args.fileKey as string | undefined;
        if (!resolvedFileKey) {
          const fileInfo = await sendToFigma('get_file_info') as { fileKey?: string };
          resolvedFileKey = fileInfo.fileKey;
        }
        if (!resolvedFileKey) {
          throw new McpError(ErrorCode.InternalError, 'fileKey를 가져올 수 없습니다. fileKey 파라미터를 직접 전달해주세요.');
        }

        // Fetch comments
        const res = await fetch(`https://api.figma.com/v1/files/${resolvedFileKey}/comments`, {
          headers: { 'X-Figma-Token': apiToken },
        });
        if (!res.ok) {
          throw new McpError(ErrorCode.InternalError, `Figma API 오류: ${res.status} ${res.statusText}`);
        }

        const data = await res.json() as { comments: FigmaComment[] };

        // Filter unresolved only
        const unresolvedComments = data.comments.filter((c) => c.resolved_at == null);

        // Group by thread (top-level comments with their replies)
        const topLevel = unresolvedComments.filter((c) => !c.parent_id);
        const replies = unresolvedComments.filter((c) => c.parent_id);
        const replyMap = new Map<string, FigmaComment[]>();
        for (const r of replies) {
          const pid = r.parent_id!;
          const list = replyMap.get(pid) ?? [];
          list.push(r);
          replyMap.set(pid, list);
        }

        // Collect unique node IDs
        const nodeIds = new Set<string>();
        for (const c of topLevel) {
          const nodeId = c.client_meta?.node_id;
          if (nodeId) nodeIds.add(nodeId);
        }

        // Fetch node info for each unique nodeId (parallel, 10s timeout per node)
        const detail = (args.detail as string) ?? 'minimal';
        const nodeInfoMap = new Map<string, unknown>();
        const nodeIdArray = [...nodeIds];
        const results = await Promise.allSettled(
          nodeIdArray.map((nodeId) =>
            sendToFigma('get_node', { nodeId, maxDepth: 1, detail }, 10_000)
          )
        );
        for (let i = 0; i < nodeIdArray.length; i++) {
          const r = results[i];
          nodeInfoMap.set(
            nodeIdArray[i],
            r.status === 'fulfilled' ? r.value : { error: `노드 조회 실패: ${r.reason}` }
          );
        }

        // Build result
        const analyzed = topLevel.map((c) => {
          const nodeId = c.client_meta?.node_id;
          const entry: Record<string, unknown> = {
            commentId: c.id,
            author: c.user?.handle ?? 'Unknown',
            message: c.message,
            createdAt: c.created_at,
          };

          // Position
          if (nodeId) {
            entry.nodeId = nodeId;
            entry.position = c.client_meta?.node_offset ?? null;
          } else if (c.client_meta?.x !== undefined) {
            entry.canvasPosition = { x: c.client_meta.x, y: c.client_meta.y };
          }

          // Replies
          const threadReplies = replyMap.get(c.id);
          if (threadReplies?.length) {
            entry.replies = threadReplies.map((r) => ({
              author: r.user?.handle ?? 'Unknown',
              message: r.message,
              createdAt: r.created_at,
            }));
          }

          // Node info
          if (nodeId && nodeInfoMap.has(nodeId)) {
            entry.node = nodeInfoMap.get(nodeId);
          }

          return entry;
        });

        const result: Record<string, unknown> = {
          fileKey: resolvedFileKey,
          unresolvedCount: topLevel.length,
          detail,
          comments: analyzed,
        };

        if (topLevel.length > 20) {
          result.warning = `미해결 댓글이 ${topLevel.length}개입니다. 특정 댓글의 노드를 상세히 보려면 figma_get_node(nodeId, detail:"standard")로 재조회하세요.`;
        }

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `알 수 없는 도구: ${name}`);
    }
  } catch (e) {
    if (e instanceof McpError) throw e;
    throw new McpError(ErrorCode.InternalError, String(e));
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

function log(msg: string) {
  // stderr so it doesn't interfere with MCP stdio protocol
  process.stderr.write(`[figma-mcp] ${msg}\n`);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP 서버 시작됨 (stdio)');
}

main().catch((e) => {
  log(`Fatal: ${e}`);
  process.exit(1);
});
