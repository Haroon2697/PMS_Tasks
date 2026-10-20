/**
 * Interactive Process Tree Diagram Component — Task 10.
 *
 * Visualizes block-structured Process Trees discovered by the Inductive Miner.
 * Features:
 * - Dynamic hierarchical tree layout
 * - Distinct operator badges: Sequence (→), Choice (×), Parallel (∧), Loop (⟳)
 * - Distinct activity leaves & silent tau (τ) nodes
 * - Smooth Bézier connecting arcs
 * - Zoom & pan controls (Zoom In, Zoom Out, Reset, Fit)
 * - Interactive node selection with full discovery rule inspection
 */

import { useMemo, useRef, useState } from 'react';
import type { ProcessTreeNode } from '@vmq/engine';

interface LayoutNode {
  id: string;
  node: ProcessTreeNode;
  x: number;
  y: number;
  width: number;
  height: number;
  children: LayoutNode[];
}

interface ProcessTreeDiagramProps {
  tree: ProcessTreeNode;
  onSelectNode?: (node: ProcessTreeNode) => void;
  selectedNodeId?: string | null;
}

const OP_RADIUS = 22;
const LEAF_W = 120;
const LEAF_H = 44;
const TAU_W = 54;
const TAU_H = 34;
const LEVEL_HEIGHT = 88;
const SIBLING_GAP = 20;

function computeLayout(node: ProcessTreeNode, depth = 0): LayoutNode {
  const isOp = node.type === 'operator';
  const isTau = node.type === 'tau';
  const width = isOp ? OP_RADIUS * 2 : isTau ? TAU_W : LEAF_W;
  const height = isOp ? OP_RADIUS * 2 : isTau ? TAU_H : LEAF_H;

  if (!node.children || node.children.length === 0) {
    return {
      id: node.id,
      node,
      x: 0,
      y: depth * LEVEL_HEIGHT,
      width,
      height,
      children: [],
    };
  }

  const childLayouts = node.children.map((c) => computeLayout(c, depth + 1));

  // Compute total width needed for children
  const totalChildrenWidth =
    childLayouts.reduce((sum, c) => sum + c.width, 0) +
    (childLayouts.length - 1) * SIBLING_GAP;

  const myWidth = Math.max(width, totalChildrenWidth);

  // Position children horizontally
  let curX = -totalChildrenWidth / 2;
  for (const child of childLayouts) {
    child.x = curX + child.width / 2;
    curX += child.width + SIBLING_GAP;
  }

  return {
    id: node.id,
    node,
    x: 0,
    y: depth * LEVEL_HEIGHT,
    width: myWidth,
    height,
    children: childLayouts,
  };
}

/** Flatten layout nodes into absolute positions */
interface FlatNode {
  id: string;
  node: ProcessTreeNode;
  x: number;
  y: number;
  width: number;
  height: number;
  parent?: FlatNode;
}

function flattenTree(
  root: LayoutNode,
  offsetX = 0,
  offsetY = 0,
  parent?: FlatNode,
): { nodes: FlatNode[]; bounds: { minX: number; maxX: number; minY: number; maxY: number } } {
  const nodes: FlatNode[] = [];
  const absX = root.x + offsetX;
  const absY = root.y + offsetY;

  const current: FlatNode = {
    id: root.id,
    node: root.node,
    x: absX,
    y: absY,
    width: root.node.type === 'operator' ? OP_RADIUS * 2 : root.node.type === 'tau' ? TAU_W : LEAF_W,
    height: root.node.type === 'operator' ? OP_RADIUS * 2 : root.node.type === 'tau' ? TAU_H : LEAF_H,
    parent,
  };
  nodes.push(current);

  for (const child of root.children) {
    const sub = flattenTree(child, absX, 0, current);
    nodes.push(...sub.nodes);
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.width / 2);
    maxX = Math.max(maxX, n.x + n.width / 2);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y + n.height);
  }

  return { nodes, bounds: { minX, maxX, minY, maxY } };
}

export function ProcessTreeDiagram({
  tree,
  onSelectNode,
  selectedNodeId,
}: ProcessTreeDiagramProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const containerRef = useRef<HTMLDivElement>(null);

  const { nodes, bounds } = useMemo(() => {
    const layout = computeLayout(tree);
    return flattenTree(layout);
  }, [tree]);

  const svgWidth = Math.max(700, bounds.maxX - bounds.minX + 120);
  const svgHeight = Math.max(400, bounds.maxY - bounds.minY + 120);
  const shiftX = -bounds.minX + 60;
  const shiftY = 40;

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsPanning(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPanning) return;
    setPan({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => setIsPanning(false);

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const fitView = () => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const scaleX = (rect.width - 40) / svgWidth;
    const scaleY = (rect.height - 40) / svgHeight;
    const fitScale = Math.min(1.2, Math.max(0.4, Math.min(scaleX, scaleY)));
    setZoom(fitScale);
    setPan({ x: 0, y: 0 });
  };

  const getOperatorColor = (op?: string) => {
    switch (op) {
      case '->':
        return { bg: 'rgba(42, 120, 214, 0.16)', border: '#2a78d6', text: '#2a78d6', title: 'Sequence (→)' };
      case 'x':
        return { bg: 'rgba(235, 104, 52, 0.16)', border: '#eb6834', text: '#eb6834', title: 'Exclusive Choice (×)' };
      case '^':
        return { bg: 'rgba(27, 175, 122, 0.16)', border: '#1baf7a', text: '#1baf7a', title: 'Parallel Concurrency (∧)' };
      case 'loop':
        return { bg: 'rgba(168, 85, 247, 0.16)', border: '#a855f7', text: '#a855f7', title: 'Loop (⟳)' };
      default:
        return { bg: 'var(--surface-2)', border: 'var(--border-strong)', text: 'var(--text-primary)', title: op };
    }
  };

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', position: 'relative' }}>
      {/* Top Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface-1)',
        }}
      >
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Discovered Process Tree</span>
          <span className="small muted">
            ({nodes.length} nodes · block-structured Workflow Net)
          </span>
        </div>

        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span className="small muted" style={{ marginRight: 6 }}>
            {Math.round(zoom * 100)}%
          </span>
          <button
            className="btn sm"
            onClick={() => setZoom((z) => Math.min(2.5, z + 0.15))}
            title="Zoom in"
          >
            +
          </button>
          <button
            className="btn sm"
            onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))}
            title="Zoom out"
          >
            −
          </button>
          <button className="btn sm" onClick={resetView} title="Reset zoom">
            1:1
          </button>
          <button className="btn sm" onClick={fitView} title="Fit to view">
            ⛶ Fit
          </button>
        </div>
      </div>

      {/* Canvas Area */}
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{
          width: '100%',
          height: 480,
          background: 'var(--surface-2)',
          cursor: isPanning ? 'grabbing' : 'grab',
          position: 'relative',
          overflow: 'hidden',
          userSelect: 'none',
        }}
      >
        <svg
          width="100%"
          height="100%"
          style={{ overflow: 'visible' }}
        >
          <g
            transform={`translate(${pan.x}, ${pan.y}) scale(${zoom}) translate(${shiftX}, ${shiftY})`}
          >
            {/* Draw Connecting Arcs (Bézier curves) */}
            {nodes.map((node) => {
              if (!node.parent) return null;
              const px = node.parent.x;
              const py = node.parent.y + node.parent.height;
              const cx = node.x;
              const cy = node.y;
              const midY = (py + cy) / 2;
              const path = `M ${px} ${py} C ${px} ${midY}, ${cx} ${midY}, ${cx} ${cy}`;

              const isHighlighted = selectedNodeId === node.id || selectedNodeId === node.parent.id;

              return (
                <path
                  key={`edge_${node.parent.id}_${node.id}`}
                  d={path}
                  fill="none"
                  stroke={isHighlighted ? 'var(--series-1)' : 'var(--border-strong)'}
                  strokeWidth={isHighlighted ? 2.5 : 1.5}
                  strokeDasharray={node.node.type === 'tau' ? '4,4' : undefined}
                  style={{ transition: 'stroke 0.15s ease' }}
                />
              );
            })}

            {/* Draw Nodes */}
            {nodes.map((n) => {
              const isSelected = selectedNodeId === n.id;
              const isOp = n.node.type === 'operator';
              const isTau = n.node.type === 'tau';

              if (isOp) {
                const opInfo = getOperatorColor(n.node.operator);
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x}, ${n.y + OP_RADIUS})`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectNode?.(n.node);
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <circle
                      r={OP_RADIUS}
                      fill={opInfo.bg}
                      stroke={isSelected ? 'var(--text-primary)' : opInfo.border}
                      strokeWidth={isSelected ? 3 : 2}
                    />
                    <text
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill={opInfo.text}
                      fontSize={16}
                      fontWeight="700"
                    >
                      {n.node.label}
                    </text>
                    <title>{`${opInfo.title}: ${n.node.discoveryRule?.name ?? ''}`}</title>
                  </g>
                );
              }

              if (isTau) {
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x - TAU_W / 2}, ${n.y})`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectNode?.(n.node);
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <rect
                      width={TAU_W}
                      height={TAU_H}
                      rx={6}
                      fill="var(--surface-1)"
                      stroke={isSelected ? 'var(--text-primary)' : 'var(--border)'}
                      strokeWidth={isSelected ? 2.5 : 1.5}
                      strokeDasharray="4,3"
                    />
                    <text
                      x={TAU_W / 2}
                      y={TAU_H / 2}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="var(--text-muted)"
                      fontSize={13}
                      fontStyle="italic"
                    >
                      τ (skip)
                    </text>
                  </g>
                );
              }

              // Activity leaf card
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x - LEAF_W / 2}, ${n.y})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectNode?.(n.node);
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <rect
                    width={LEAF_W}
                    height={LEAF_H}
                    rx={6}
                    fill={isSelected ? 'var(--surface-3)' : 'var(--surface-1)'}
                    stroke={isSelected ? 'var(--series-1)' : 'var(--border)'}
                    strokeWidth={isSelected ? 2.5 : 1}
                  />
                  <rect
                    width={4}
                    height={LEAF_H}
                    rx={2}
                    fill="var(--series-1)"
                  />
                  <text
                    x={LEAF_W / 2 + 2}
                    y={LEAF_H / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="var(--text-primary)"
                    fontSize={11}
                    fontWeight="500"
                  >
                    {n.node.label.length > 15 ? `${n.node.label.slice(0, 14)}…` : n.node.label}
                  </text>
                  <title>{n.node.label}</title>
                </g>
              );
            })}
          </g>
        </svg>

        {/* Legend Overlay */}
        <div
          style={{
            position: 'absolute',
            bottom: 12,
            left: 12,
            background: 'var(--surface-1)',
            padding: '6px 12px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            display: 'flex',
            gap: 12,
            fontSize: 11,
            pointerEvents: 'none',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <strong style={{ color: '#2a78d6' }}>→</strong> Sequence
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <strong style={{ color: '#eb6834' }}>×</strong> Exclusive (XOR)
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <strong style={{ color: '#1baf7a' }}>∧</strong> Parallel (AND)
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <strong style={{ color: '#a855f7' }}>⟳</strong> Loop
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: 'var(--text-muted)' }}>τ</span> Silent Skip
          </span>
        </div>
      </div>
    </div>
  );
}
