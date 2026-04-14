/// <reference types="@figma/plugin-typings" />

// ─── Types ───────────────────────────────────────────────────────────────────

type DetailLevel = 'minimal' | 'standard' | 'full';

// ─── Default Values (stripped from output) ───────────────────────────────────

const DEFAULT_VALUES: Record<string, unknown> = {
  visible: true,
  locked: false,
  opacity: 1,
  rotation: 0,
  blendMode: 'PASS_THROUGH',
  layoutAlign: 'INHERIT',
  layoutGrow: 0,
  strokeAlign: 'INSIDE',
  textCase: 'ORIGINAL',
  textDecoration: 'NONE',
  textAlignHorizontal: 'LEFT',
  textAlignVertical: 'TOP',
  paragraphSpacing: 0,
  paragraphIndent: 0,
};

// ─── Serialization Helpers ────────────────────────────────────────────────────

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function cleanOutput(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (key in DEFAULT_VALUES && value === DEFAULT_VALUES[key]) continue;

    if (Array.isArray(value)) {
      const cleaned = value.map(item =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? cleanOutput(item as Record<string, unknown>)
          : item
      );
      result[key] = cleaned;
    } else if (typeof value === 'object') {
      const cleaned = cleanOutput(value as Record<string, unknown>);
      if (Object.keys(cleaned).length === 0) continue;
      result[key] = cleaned;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function serializePaint(paint: Paint): object {
  const base: Record<string, unknown> = { type: paint.type };
  if (paint.visible === false) base.visible = false;
  if (paint.opacity !== undefined && paint.opacity !== 1) base.opacity = paint.opacity;

  if (paint.type === 'SOLID') {
    return { ...base, color: rgbToHex(paint.color.r, paint.color.g, paint.color.b) };
  }
  if (
    paint.type === 'GRADIENT_LINEAR' ||
    paint.type === 'GRADIENT_RADIAL' ||
    paint.type === 'GRADIENT_ANGULAR' ||
    paint.type === 'GRADIENT_DIAMOND'
  ) {
    return {
      ...base,
      stops: paint.gradientStops.map((s) => ({
        color: rgbToHex(s.color.r, s.color.g, s.color.b),
        alpha: s.color.a,
        position: s.position,
      })),
    };
  }
  if (paint.type === 'IMAGE') {
    return { ...base, imageHash: paint.imageHash, scaleMode: paint.scaleMode };
  }
  return base;
}

function serializeEffect(effect: Effect): object {
  switch (effect.type) {
    case 'DROP_SHADOW':
    case 'INNER_SHADOW':
      return {
        type: effect.type,
        color: rgbToHex(effect.color.r, effect.color.g, effect.color.b),
        alpha: effect.color.a,
        offset: { x: effect.offset.x, y: effect.offset.y },
        radius: effect.radius,
        spread: effect.spread,
        visible: effect.visible,
      };
    case 'LAYER_BLUR':
    case 'BACKGROUND_BLUR':
      return { type: effect.type, radius: effect.radius, visible: effect.visible };
    default:
      return { type: effect.type };
  }
}

function isMixed(val: unknown): boolean {
  return val === figma.mixed;
}

function safeVal<T>(val: T | typeof figma.mixed): T | 'MIXED' {
  return isMixed(val) ? 'MIXED' : (val as T);
}

// ─── Detail Level Auto-Reduction ─────────────────────────────────────────────

function computeEffectiveDetail(
  requested: DetailLevel,
  depth: number,
  siblingCount: number
): DetailLevel {
  // Large scope: aggressively reduce
  if (siblingCount > 50) {
    if (depth >= 2) return 'minimal';
    if (depth >= 1 && requested !== 'minimal') return 'standard';
  }
  // Medium scope
  if (siblingCount > 20 && depth >= 3 && requested === 'full') return 'standard';
  // Deep nesting
  if (depth >= 5) return 'minimal';
  if (depth >= 4 && requested === 'full') return 'standard';
  return requested;
}

// ─── Text Serialization ──────────────────────────────────────────────────────

function serializeTextStandard(node: TextNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    characters: node.characters,
    fontSize: safeVal(node.fontSize),
    fontName: safeVal(node.fontName),
    letterSpacing: safeVal(node.letterSpacing),
    lineHeight: safeVal(node.lineHeight),
    textCase: safeVal(node.textCase),
    textDecoration: safeVal(node.textDecoration),
    textAlignHorizontal: node.textAlignHorizontal,
    textAlignVertical: node.textAlignVertical,
    textAutoResize: node.textAutoResize,
    paragraphSpacing: node.paragraphSpacing,
    paragraphIndent: node.paragraphIndent,
  };
  const fills = node.fills;
  if (!isMixed(fills)) {
    out.fills = (fills as Paint[]).map(serializePaint);
  } else {
    out.fills = 'MIXED';
  }
  return out;
}

function serializeTextFull(node: TextNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Truncation
  try {
    if ('textTruncation' in node) out.textTruncation = (node as any).textTruncation;
    if ('maxLines' in node) out.maxLines = (node as any).maxLines;
  } catch (_) {}
  // Hyperlink
  try {
    const hl = safeVal((node as any).hyperlink);
    if (hl && hl !== 'MIXED') out.hyperlink = hl;
  } catch (_) {}
  // Style ID
  try {
    const tsid = safeVal(node.textStyleId);
    if (tsid && tsid !== 'MIXED') out.textStyleId = tsid;
  } catch (_) {}
  // Styled segments (per-character styles)
  try {
    const segments = (node as any).getStyledTextSegments([
      'fontSize', 'fontName', 'fontWeight', 'textDecoration',
      'textCase', 'lineHeight', 'letterSpacing', 'fills',
      'hyperlink', 'listOptions', 'indentation',
    ]);
    if (segments && segments.length > 1) {
      out.styledSegments = segments.map((s: any) => {
        const seg: Record<string, unknown> = {
          characters: s.characters,
          start: s.start,
          end: s.end,
        };
        if (s.fontSize) seg.fontSize = s.fontSize;
        if (s.fontName) seg.fontName = s.fontName;
        if (s.fontWeight) seg.fontWeight = s.fontWeight;
        if (s.fills?.length) seg.fills = s.fills.map(serializePaint);
        if (s.hyperlink) seg.hyperlink = s.hyperlink;
        if (s.listOptions) seg.listOptions = s.listOptions;
        if (s.indentation) seg.indentation = s.indentation;
        return seg;
      });
    }
  } catch (_) {}
  return out;
}

// ─── Full Detail Extras ──────────────────────────────────────────────────────

function serializeFullDetails(node: SceneNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Absolute position
  try {
    if ('absoluteBoundingBox' in node) {
      const bb = (node as any).absoluteBoundingBox;
      if (bb) out.absoluteBoundingBox = { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
    }
  } catch (_) {}

  // Bound variables (design tokens)
  try {
    if ('boundVariables' in node) {
      const bv = (node as any).boundVariables;
      if (bv && Object.keys(bv).length > 0) out.boundVariables = bv;
    }
  } catch (_) {}

  // Frame-specific
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || node.type === 'INSTANCE') {
    const f = node as FrameNode;
    try {
      if (f.clipsContent !== undefined) out.clipsContent = f.clipsContent;
      if (f.layoutGrids?.length) out.layoutGrids = f.layoutGrids;
      if (f.guides?.length) out.guides = f.guides;
      if ('overflowDirection' in f) out.overflowDirection = (f as any).overflowDirection;
      if ('strokesIncludedInLayout' in f) out.strokesIncludedInLayout = (f as any).strokesIncludedInLayout;
      if ('counterAxisSpacing' in f) {
        const cas = (f as any).counterAxisSpacing;
        if (cas !== null && cas !== undefined) out.counterAxisSpacing = cas;
      }
    } catch (_) {}
  }

  // INSTANCE-specific
  if (node.type === 'INSTANCE') {
    const inst = node as InstanceNode;
    try {
      if (inst.componentProperties && Object.keys(inst.componentProperties).length > 0) {
        out.componentProperties = inst.componentProperties;
      }
    } catch (_) {}
    try {
      if ('overrides' in inst) {
        const ov = (inst as any).overrides;
        if (ov?.length) out.overrides = ov;
      }
    } catch (_) {}
    try {
      if (inst.mainComponent?.parent?.type === 'COMPONENT_SET') {
        const cs = inst.mainComponent.parent as ComponentSetNode;
        if ('variantGroupProperties' in cs) {
          out.variantGroupProperties = (cs as any).variantGroupProperties;
        }
      }
    } catch (_) {}
  }

  // COMPONENT-specific
  if (node.type === 'COMPONENT') {
    const comp = node as ComponentNode;
    try {
      if ('componentPropertyDefinitions' in comp && Object.keys(comp.componentPropertyDefinitions).length > 0) {
        out.componentPropertyDefinitions = comp.componentPropertyDefinitions;
      }
    } catch (_) {}
    try {
      if (comp.documentationLinks?.length) out.documentationLinks = comp.documentationLinks;
    } catch (_) {}
  }

  // COMPONENT_SET-specific
  if (node.type === 'COMPONENT_SET') {
    const cs = node as ComponentSetNode;
    try {
      if ('componentPropertyDefinitions' in cs && Object.keys(cs.componentPropertyDefinitions).length > 0) {
        out.componentPropertyDefinitions = cs.componentPropertyDefinitions;
      }
    } catch (_) {}
  }

  // Reactions (prototyping)
  try {
    if ('reactions' in node) {
      const reactions = (node as any).reactions;
      if (reactions?.length) {
        out.reactions = reactions.map((r: any) => ({
          trigger: r.trigger,
          actions: r.actions,
        }));
      }
    }
  } catch (_) {}

  // Fill/stroke style IDs
  try {
    if ('fillStyleId' in node) {
      const fsid = safeVal((node as any).fillStyleId);
      if (fsid && fsid !== '' && fsid !== 'MIXED') out.fillStyleId = fsid;
    }
    if ('strokeStyleId' in node) {
      const ssid = safeVal((node as any).strokeStyleId);
      if (ssid && ssid !== '' && ssid !== 'MIXED') out.strokeStyleId = ssid;
    }
    if ('effectStyleId' in node) {
      const esid = safeVal((node as any).effectStyleId);
      if (esid && esid !== '' && esid !== 'MIXED') out.effectStyleId = esid;
    }
  } catch (_) {}

  return out;
}

// ─── Page Serialization ──────────────────────────────────────────────────────

function serializePage(page: PageNode, detail: DetailLevel): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: page.id,
    name: page.name,
    type: 'PAGE',
    childCount: page.children.length,
    topLevelFrames: page.children.map(child => {
      const info: Record<string, unknown> = {
        id: child.id,
        name: child.name,
        type: child.type,
      };
      if ('width' in child) {
        info.width = (child as SceneNode & { width: number }).width;
        info.height = (child as SceneNode & { height: number }).height;
      }
      return info;
    }),
  };
  if (detail === 'full') {
    out.backgrounds = page.backgrounds?.map(serializePaint);
    try {
      if (page.prototypeStartNode) {
        out.prototypeStartNodeID = page.prototypeStartNode.id;
      }
    } catch (_) {}
  }
  return cleanOutput(out);
}

// ─── Main Serializer ─────────────────────────────────────────────────────────

function serializeNode(
  node: SceneNode,
  depth: number = 0,
  maxDepth: number = 5,
  detail: DetailLevel = 'standard',
  siblingCount: number = 0
): Record<string, unknown> {
  const effectiveDetail = computeEffectiveDetail(detail, depth, siblingCount);

  // ═══ MINIMAL: id, name, type, size ═══
  const out: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
  };
  if ('width' in node) { out.width = node.width; out.height = node.height; }

  if (effectiveDetail === 'minimal') {
    if ('children' in node) out.childCount = (node as ChildrenMixin).children.length;
    return cleanOutput(out);
  }

  // ═══ STANDARD: layout, fills, typography, component info ═══

  // Geometry basics
  if ('locked' in node) out.locked = node.locked;
  if ('x' in node) out.x = node.x;
  if ('y' in node) out.y = node.y;
  if ('rotation' in node) out.rotation = node.rotation;
  if ('opacity' in node) out.opacity = node.opacity;
  if ('blendMode' in node) out.blendMode = node.blendMode;
  if ('visible' in node) out.visible = node.visible;

  // Fills & strokes
  if ('fills' in node) {
    out.fills = isMixed(node.fills) ? 'MIXED' : (node.fills as Paint[]).map(serializePaint);
  }
  if ('strokes' in node && (node as GeometryMixin).strokes.length > 0) {
    out.strokes = (node as GeometryMixin).strokes.map(serializePaint);
    if ('strokeWeight' in node) out.strokeWeight = safeVal((node as GeometryMixin).strokeWeight);
    if ('strokeAlign' in node) out.strokeAlign = (node as GeometryMixin).strokeAlign;
    if ('dashPattern' in node && (node as GeometryMixin).dashPattern.length > 0) {
      out.dashPattern = (node as GeometryMixin).dashPattern;
    }
  }

  // Corner radius
  if ('cornerRadius' in node) {
    const cr = (node as CornerMixin).cornerRadius;
    if (!isMixed(cr) && cr !== 0) out.cornerRadius = cr;
    else if (isMixed(cr)) out.cornerRadius = 'MIXED';
  }
  if ('topLeftRadius' in node) {
    const n = node as RectangleNode;
    if (n.topLeftRadius || n.topRightRadius || n.bottomLeftRadius || n.bottomRightRadius) {
      out.cornerRadii = {
        topLeft: n.topLeftRadius,
        topRight: n.topRightRadius,
        bottomLeft: n.bottomLeftRadius,
        bottomRight: n.bottomRightRadius,
      };
    }
  }

  // Effects
  if ('effects' in node && (node as BlendMixin).effects.length > 0) {
    out.effects = (node as BlendMixin).effects.map(serializeEffect);
  }

  // Auto layout
  if ('layoutMode' in node) {
    const n = node as FrameNode;
    if (n.layoutMode !== 'NONE') {
      out.layout = {
        mode: n.layoutMode,
        primaryAxisSizing: n.primaryAxisSizingMode,
        counterAxisSizing: n.counterAxisSizingMode,
        primaryAxisAlign: n.primaryAxisAlignItems,
        counterAxisAlign: n.counterAxisAlignItems,
        paddingTop: n.paddingTop,
        paddingRight: n.paddingRight,
        paddingBottom: n.paddingBottom,
        paddingLeft: n.paddingLeft,
        itemSpacing: n.itemSpacing,
        layoutWrap: n.layoutWrap,
      };
    }
  }

  // Layout child sizing
  if ('layoutAlign' in node) out.layoutAlign = (node as LayoutMixin).layoutAlign;
  if ('layoutGrow' in node) out.layoutGrow = (node as LayoutMixin).layoutGrow;
  if ('layoutSizingHorizontal' in node) out.layoutSizingHorizontal = (node as LayoutMixin).layoutSizingHorizontal;
  if ('layoutSizingVertical' in node) out.layoutSizingVertical = (node as LayoutMixin).layoutSizingVertical;

  // Constraints
  if ('constraints' in node) out.constraints = (node as ConstraintMixin).constraints;

  // ── SECTION-specific ──
  if (node.type === 'SECTION') {
    if ('fills' in node) {
      out.fills = isMixed((node as any).fills) ? 'MIXED' : ((node as any).fills as Paint[]).map(serializePaint);
    }
    try {
      if ('devStatus' in node) out.devStatus = (node as any).devStatus;
    } catch (_) {}
  }

  // ── TEXT-specific ──
  if (node.type === 'TEXT') {
    Object.assign(out, serializeTextStandard(node));
    if (effectiveDetail === 'full') {
      Object.assign(out, serializeTextFull(node));
    }
  }

  // ── INSTANCE-specific ──
  if (node.type === 'INSTANCE') {
    try {
      out.componentId = node.mainComponent?.id;
      out.componentName = node.mainComponent?.name;
      out.componentSetName = node.mainComponent?.parent?.type === 'COMPONENT_SET'
        ? node.mainComponent.parent.name
        : undefined;
    } catch (_) {}
  }

  // ── COMPONENT-specific ──
  if (node.type === 'COMPONENT') {
    out.description = node.description || undefined;
    out.remote = node.remote;
  }

  // ── COMPONENT_SET-specific ──
  if (node.type === 'COMPONENT_SET') {
    out.description = (node as ComponentSetNode).description || undefined;
    out.remote = (node as ComponentSetNode).remote;
  }

  // ═══ FULL: extra details ═══
  if (effectiveDetail === 'full') {
    Object.assign(out, serializeFullDetails(node));
  }

  // ═══ CHILDREN (recursive) ═══
  if ('children' in node && depth < maxDepth) {
    const children = (node as ChildrenMixin).children;
    const childCount = children.length;
    out.children = children.map((child) =>
      serializeNode(child as SceneNode, depth + 1, maxDepth, detail, childCount)
    );
  } else if ('children' in node) {
    out.childCount = (node as ChildrenMixin).children.length;
  }

  return cleanOutput(out);
}

// ─── Plugin Entry ─────────────────────────────────────────────────────────────

figma.showUI(__html__, {
  width: 280,
  height: 380,
  themeColors: true,
});

figma.ui.onmessage = async (msg: { type: string; payload?: Record<string, unknown>; requestId?: string }) => {
  const { type, payload = {}, requestId } = msg;

  const reply = (data: unknown) =>
    figma.ui.postMessage({ type: 'response', requestId, data });

  const replyError = (error: string) =>
    figma.ui.postMessage({ type: 'response', requestId, error });

  try {
    switch (type) {
      // ── Selection ──────────────────────────────────────────────────────────
      case 'get_selection': {
        const maxDepth = (payload.maxDepth as number) ?? 5;
        const detail = (payload.detail as DetailLevel) ?? 'standard';
        const nodes = figma.currentPage.selection.map((n) => serializeNode(n, 0, maxDepth, detail));
        reply({ nodes, count: nodes.length });
        break;
      }

      // ── Single node by ID ──────────────────────────────────────────────────
      case 'get_node': {
        const nodeId = payload.nodeId as string;
        const node = figma.getNodeById(nodeId);
        if (!node) {
          replyError(`Node "${nodeId}" not found`);
          return;
        }
        const maxDepth = (payload.maxDepth as number) ?? 5;
        const detail = (payload.detail as DetailLevel) ?? 'standard';

        // PAGE nodes
        if (node.type === 'PAGE') {
          reply(serializePage(node as PageNode, detail));
          return;
        }
        if (node.type === 'DOCUMENT') {
          replyError('Cannot serialize DOCUMENT node');
          return;
        }
        reply(serializeNode(node as SceneNode, 0, maxDepth, detail));
        break;
      }

      // ── All nodes on current page ──────────────────────────────────────────
      case 'get_page_nodes': {
        const maxDepth = (payload.maxDepth as number) ?? 3;
        const detail = (payload.detail as DetailLevel) ?? 'standard';
        const children = figma.currentPage.children;
        const childCount = children.length;
        const nodes = children.map((n) =>
          serializeNode(n as SceneNode, 0, maxDepth, detail, childCount)
        );
        const result: Record<string, unknown> = {
          pageName: figma.currentPage.name,
          nodeCount: nodes.length,
          nodes,
        };
        if (childCount > 30) {
          result.warning = `노드가 ${childCount}개로 응답이 매우 클 수 있습니다. detail:"minimal"로 변경하거나, 특정 노드를 figma_get_node로 직접 조회하여 범위를 줄여주세요.`;
        }
        reply(result);
        break;
      }

      // ── File info ──────────────────────────────────────────────────────────
      case 'get_file_info': {
        reply({
          fileName: figma.root.name,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fileKey: (figma as any).fileKey ?? null,
          pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
          currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
          selectionCount: figma.currentPage.selection.length,
        });
        break;
      }

      // ── Comments ───────────────────────────────────────────────────────────
      case 'get_comments': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const getCommentsAsync = (figma as any).getCommentsAsync;
        if (typeof getCommentsAsync !== 'function') {
          replyError('figma.getCommentsAsync is not supported in Figma Desktop plugin API. Use the Figma REST API MCP (figma_get_comments) instead.');
          break;
        }
        const comments = await getCommentsAsync.call(figma) as any[];
        const serialized = comments.map((c: any) => ({
          id: c.id,
          message: c.message,
          author: c.author,
          createdAt: c.createdAt,
          resolved: c.resolvedAt !== null,
          resolvedAt: c.resolvedAt,
          orderId: c.orderId,
          reactions: c.reactions,
          position: c.clientMeta && 'x' in c.clientMeta
            ? { x: c.clientMeta.x, y: c.clientMeta.y }
            : { nodeId: c.clientMeta?.node?.id, offset: c.clientMeta?.offset },
        }));
        reply({ count: serialized.length, comments: serialized });
        break;
      }

      // ── Export node as image ───────────────────────────────────────────────
      case 'export_node': {
        const nodeId = payload.nodeId as string;
        const node = figma.getNodeById(nodeId);
        if (!node || !('exportAsync' in node)) {
          replyError(`Node "${nodeId}" not found or not exportable`);
          return;
        }
        const format = (payload.format as 'PNG' | 'JPG' | 'SVG') ?? 'PNG';
        const scale = (payload.scale as number) ?? 2;
        const bytes = await (node as ExportMixin).exportAsync({
          format,
          constraint: { type: 'SCALE', value: scale },
        });
        const base64 = figma.base64Encode(bytes);
        reply({ base64, format });
        break;
      }

      // ── Local styles ───────────────────────────────────────────────────────
      case 'get_styles': {
        reply({
          paintStyles: figma.getLocalPaintStyles().map((s) => ({
            id: s.id, name: s.name, key: s.key,
            paints: (s.paints as Paint[]).map(serializePaint),
          })),
          textStyles: figma.getLocalTextStyles().map((s) => ({
            id: s.id, name: s.name, key: s.key,
            fontSize: s.fontSize, fontName: s.fontName,
            lineHeight: s.lineHeight, letterSpacing: s.letterSpacing,
          })),
          effectStyles: figma.getLocalEffectStyles().map((s) => ({
            id: s.id, name: s.name, key: s.key,
            effects: (s.effects as Effect[]).map(serializeEffect),
          })),
        });
        break;
      }

      default:
        replyError(`Unknown message type: "${type}"`);
    }
  } catch (e) {
    replyError(String(e));
  }
};
