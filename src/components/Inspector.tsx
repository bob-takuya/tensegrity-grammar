/**
 * Inspector — real-time visualisation of the Class-1 search.
 *
 * Shows three things:
 *   1. A live event log (every phase / adhesion / LP check / fusion)
 *   2. Rolling table snapshots (NODE / MEMBER / CELL / SELF_STRESS_STATE /
 *      MORPHOGENESIS_STEP)
 *   3. The current morphogenesis graph Gc (cell adjacency summary)
 *
 * Each event references member / node / cell ids; clicking on a row
 * scrolls the highlighted entity into the corresponding table.
 */

import React, { useMemo, useState } from 'react';
import { useAppState } from '../state/context';
import type { SearchEvent, SearchEventKind } from '../morphogenesis/types';

type Tab = 'events' | 'tables' | 'graph';

const KIND_LABEL: Record<SearchEventKind, string> = {
  phase: 'PHASE',
  init: 'INIT',
  adhesion: 'ADH',
  fusion: 'FUS',
  lp_check: 'LP',
  conflict: 'CONF',
  strategic_fusion: 'S-FUS',
  matching: 'MATCH',
  success: 'OK',
  failure: 'FAIL',
  info: 'INFO',
};

const KIND_COLOR: Record<SearchEventKind, string> = {
  phase: '#6a1b9a',
  init: '#1565c0',
  adhesion: '#2e7d32',
  fusion: '#c62828',
  lp_check: '#00796b',
  conflict: '#e65100',
  strategic_fusion: '#d84315',
  matching: '#4e342e',
  success: '#2e7d32',
  failure: '#b71c1c',
  info: '#616161',
};

export function Inspector() {
  const { state } = useAppState();
  const [tab, setTab] = useState<Tab>('events');
  const morpho = state.morpho;

  const strutIds = useMemo(
    () => new Set(morpho.matching ?? []),
    [morpho.matching],
  );

  // Stabilise the `events` slice passed into EventList. `morpho`
  // is a fresh object every search tick (the reducer shallow-clones
  // the outer state), but as long as the underlying events array
  // hasn't grown we can return the *same* slice reference so the
  // memoised EventList bails out instead of reconciling hundreds
  // of <li>s every frame. When new events arrive, events.length
  // changes and we recompute a fresh tail slice.
  const eventsLen = morpho.events.length;
  const recentEvents = useMemo(
    () => morpho.events.slice(Math.max(0, eventsLen - MAX_EVENT_ROWS)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eventsLen],
  );
  const eventsHidden = eventsLen - recentEvents.length;

  return (
    <div className="inspector">
      <div className="inspector-tabs">
        <button
          className={`inspector-tab ${tab === 'events' ? 'active' : ''}`}
          onClick={() => setTab('events')}
        >
          Events ({morpho.events.length})
        </button>
        <button
          className={`inspector-tab ${tab === 'tables' ? 'active' : ''}`}
          onClick={() => setTab('tables')}
        >
          Tables
        </button>
        <button
          className={`inspector-tab ${tab === 'graph' ? 'active' : ''}`}
          onClick={() => setTab('graph')}
        >
          G / G<sub>c</sub>
        </button>
      </div>

      <div className="inspector-content">
        {tab === 'events' && <EventList events={recentEvents} hidden={eventsHidden} />}
        {tab === 'tables' && <TablesView morpho={morpho} strutIds={strutIds} />}
        {tab === 'graph' && <GraphView morpho={morpho} />}
      </div>
    </div>
  );
}

// ─── Events ─────────────────────────────────────────────────

// Cap the number of event rows we actually render. During a long
// search the events array grows to hundreds of entries, and
// reconciling that many <li>s on every live tick is the dominant
// React cost — it's what keeps the viewer at ~1 fps on larger n.
// The tail is the most interesting part anyway (most recent phase,
// last LP conflict, etc.) so we slice to the most recent MAX_EVENTS.
const MAX_EVENT_ROWS = 120;

const EventList = React.memo(function EventList({
  events,
  hidden,
}: {
  events: SearchEvent[];
  hidden: number;
}) {
  if (events.length === 0 && hidden === 0) {
    return <p className="inspector-empty">No events. Click <b>Search</b> to begin.</p>;
  }
  return (
    <ol className="event-list">
      {hidden > 0 && (
        <li className="event-row" style={{ opacity: 0.6, fontStyle: 'italic' }}>
          <span className="event-message">
            … {hidden} earlier event{hidden === 1 ? '' : 's'} omitted
          </span>
        </li>
      )}
      {events.map(ev => (
        <li key={ev.event_id} className="event-row">
          <span
            className="event-tag"
            style={{ background: KIND_COLOR[ev.kind] }}
          >
            {KIND_LABEL[ev.kind]}
          </span>
          <span className="event-message">{ev.message}</span>
          {(ev.dim_W_before !== undefined || ev.dim_W_after !== undefined) && (
            <span className="event-dim">
              dim W {ev.dim_W_before ?? '?'}→{ev.dim_W_after ?? '?'}
            </span>
          )}
          {ev.member_ids && ev.member_ids.length > 0 && ev.member_ids.length <= 6 && (
            <span className="event-ids">
              m: [{ev.member_ids.join(', ')}]
            </span>
          )}
        </li>
      ))}
    </ol>
  );
});

// ─── Tables ─────────────────────────────────────────────────

function TablesView({
  morpho,
  strutIds,
}: {
  morpho: ReturnType<typeof useAppState>['state']['morpho'];
  strutIds: Set<number>;
}) {
  return (
    <div className="tables-view">
      <details open>
        <summary>NODE ({morpho.nodes.length})</summary>
        <table className="mini-table">
          <thead>
            <tr><th>id</th><th>x</th><th>y</th><th>z</th></tr>
          </thead>
          <tbody>
            {morpho.nodes.slice(0, 60).map(n => (
              <tr key={n.node_id}>
                <td>{n.node_id}</td>
                <td>{n.x.toFixed(2)}</td>
                <td>{n.y.toFixed(2)}</td>
                <td>{n.z.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details>
        <summary>MEMBER ({morpho.members.length})</summary>
        <table className="mini-table">
          <thead>
            <tr><th>id</th><th>a</th><th>b</th><th>type</th><th>q</th><th>M</th></tr>
          </thead>
          <tbody>
            {morpho.members.slice(0, 120).map(m => (
              <tr key={m.member_id}>
                <td>{m.member_id}</td>
                <td>{m.node_a}</td>
                <td>{m.node_b}</td>
                <td className={m.type === 'strut' ? 'strut-color' : m.type === 'cable' ? 'cable-color' : ''}>
                  {m.type}
                </td>
                <td>{m.force_density != null ? m.force_density.toExponential(1) : '—'}</td>
                <td>{strutIds.has(m.member_id) ? '●' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details>
        <summary>CELL ({morpho.cells.length})</summary>
        <table className="mini-table">
          <thead>
            <tr><th>id</th><th>type</th><th>step</th><th>nodes</th></tr>
          </thead>
          <tbody>
            {morpho.cells.map(c => (
              <tr key={c.cell_id}>
                <td>{c.cell_id}</td>
                <td>{c.cell_type}</td>
                <td>{c.step_created}</td>
                <td>[{c.node_ids.join(',')}]</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details>
        <summary>MORPHOGENESIS_STEP ({morpho.morphogenesisSteps.length})</summary>
        <table className="mini-table">
          <thead>
            <tr><th>id</th><th>op</th><th>Δe</th><th>Δv</th><th>ΔW<sub>p</sub></th><th>ΔW<sub>a</sub></th></tr>
          </thead>
          <tbody>
            {morpho.morphogenesisSteps.map(s => (
              <tr key={s.step_id}>
                <td>{s.step_id}</td>
                <td>{s.operation}</td>
                <td>{s.delta_e}</td>
                <td>{s.delta_v}</td>
                <td>{s.delta_dim_W_predicted}</td>
                <td>{s.delta_dim_W_actual}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details>
        <summary>SELF_STRESS_STATE ({morpho.selfStressStates.length})</summary>
        <table className="mini-table">
          <thead>
            <tr><th>id</th><th>cell_id</th><th>entries</th></tr>
          </thead>
          <tbody>
            {morpho.selfStressStates.map(s => {
              const entries = morpho.selfStressEntries.filter(e => e.state_id === s.state_id);
              return (
                <tr key={s.state_id}>
                  <td>{s.state_id}</td>
                  <td>{s.cell_id ?? '—'}</td>
                  <td>{entries.length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>

      <details>
        <summary>REMOVED_MEMBER ({morpho.removedMembers.length})</summary>
        <table className="mini-table">
          <thead><tr><th>step</th><th>member</th></tr></thead>
          <tbody>
            {morpho.removedMembers.map((r, i) => (
              <tr key={i}><td>{r.step_id}</td><td>{r.member_id}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

// ─── G / Gc ─────────────────────────────────────────────────

function GraphView({
  morpho,
}: {
  morpho: ReturnType<typeof useAppState>['state']['morpho'];
}) {
  return (
    <div className="graph-view">
      <h4>G = (V, E)</h4>
      <div className="stat-grid">
        <div className="stat"><span className="stat-label">|V|</span><span className="stat-value">{morpho.nodes.length}</span></div>
        <div className="stat"><span className="stat-label">|E|</span><span className="stat-value">{morpho.members.length}</span></div>
      </div>

      <h4 style={{ marginTop: 10 }}>G<sub>c</sub> = (V<sub>c</sub>, E<sub>c</sub>)</h4>
      <div className="stat-grid">
        <div className="stat"><span className="stat-label">|V<sub>c</sub>|</span><span className="stat-value">{morpho.cells.length}</span></div>
        <div className="stat"><span className="stat-label">|E<sub>c</sub>|</span><span className="stat-value">{morpho.cellAdjacency.length}</span></div>
      </div>

      <h4 style={{ marginTop: 10 }}>Cell adjacency</h4>
      <table className="mini-table">
        <thead>
          <tr><th>cell_i</th><th>cell_j</th><th>shared</th></tr>
        </thead>
        <tbody>
          {morpho.cellAdjacency.slice(0, 40).map((a, i) => (
            <tr key={i}>
              <td>{a.cell_i}</td>
              <td>{a.cell_j}</td>
              <td>{a.shared_members.length}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 style={{ marginTop: 10 }}>α (self-stress coefficients)</h4>
      {morpho.alpha.length === 0
        ? <p className="inspector-empty">α not yet selected.</p>
        : (
          <code className="alpha-block">
            [{morpho.alpha.map(a => a.toFixed(3)).join(', ')}]
          </code>
        )
      }
    </div>
  );
}
