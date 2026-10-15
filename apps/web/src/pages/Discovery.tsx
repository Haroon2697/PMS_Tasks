/**
 * Process Discovery — Task 7, step 2.
 *
 * Shows what was mined from the log: the activity set, the directly-follows
 * routing, the loops, the variants, the arrival process and the per-activity
 * rates — all measured, none configured.
 *
 * The section that matters most is Assumptions. A log determines the process
 * but not the capacity that ran it, and the page says so plainly: the server
 * count is a LOWER BOUND estimated from observed concurrency, and it is
 * editable right there, because correcting it is the single change that most
 * affects the queueing results downstream.
 */

import { useStore } from '../state/store';
import { Card, DataTable, EmptyState, Kpi, Notice } from '../components/primitives';
import { HorizontalBars } from '../components/charts';
import { minutes, num, pct } from '../lib/format';

export function DiscoveryPage({ navigate }: { navigate: (p: string) => void }) {
  const { eventLog, discovered, discoveredServers, setDiscoveredServers, discoveryError } =
    useStore();

  if (!eventLog) {
    return (
      <EmptyState>
        No event log loaded.{' '}
        <button className="btn sm" onClick={() => navigate('eventlog')}>
          Import one first
        </button>
      </EmptyState>
    );
  }
  if (discoveryError && !discovered) {
    return (
      <Notice kind="error" title="Discovery failed">
        {discoveryError}
      </Notice>
    );
  }
  if (!discovered) return <EmptyState>Discovering…</EmptyState>;

  const d = discovered;
  const bottleneck = d.activities.find((a) => a.id === d.bottleneckActivityId);
  const nameOf = (id: string) => d.activities.find((a) => a.id === id)?.name ?? id;

  return (
    <div className="stack">
      <p className="page-intro">
        Everything below is derived from the {d.eventCount} events in the log. Activity order comes
        from a directly-follows graph walked forward from the start activities, routing
        probabilities from observed transition frequencies, and service and arrival rates from the
        timestamps themselves.
      </p>

      <div className="grid cols-4">
        <Kpi label="Cases" value={num(d.caseCount, 0)} basis="derived" sub={`${d.eventCount} events`} />
        <Kpi
          label="Activities discovered"
          value={num(d.activities.length, 0)}
          basis="derived"
          sub={`${d.variants.length} distinct path variants`}
        />
        <Kpi
          label="Arrival rate λ"
          value={num(d.interArrival.lambdaPerHour, 3)}
          unit="cases/h"
          basis="derived"
          sub={`mean gap ${num(d.interArrival.meanMinutes, 2)} min · CV ${num(d.interArrival.cv, 2)} → ${d.interArrival.symbol}`}
        />
        <Kpi
          label="Observed cycle time"
          value={num(d.cycleTime.meanMinutes, 1)}
          unit="min"
          basis="derived"
          sub={`median ${num(d.cycleTime.medianMinutes, 0)} · p95 ${num(d.cycleTime.p95Minutes, 0)} min`}
        />
      </div>

      <div
        className="card"
        style={{
          background: 'color-mix(in srgb, var(--series-1) 8%, var(--surface-1))',
          borderColor: 'var(--series-1)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
          padding: '10px 14px',
        }}
      >
        <div>
          <div style={{ fontWeight: 600, color: 'var(--series-1)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>⚡ Discovery Algorithm: Alpha Plus (α⁺) Loop-Corrected</span>
            <span className="badge sourced">Task 9</span>
          </div>
          <div className="small muted" style={{ marginTop: 2 }}>
            Our discovery engine integrates the Alpha Plus algorithm to correctly isolate rework cycles and short loops.
            Base Alpha (α) mistakenly treats rework loops as concurrent parallelism.
          </div>
        </div>
        <button className="btn sm primary" onClick={() => navigate('alphacompare')}>
          Compare Alpha vs Alpha+ in App →
        </button>
      </div>

      {d.warnings.length > 0 ? (
        <Notice kind="warn" title="What the log does and does not support">
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {d.warnings.map((w, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {w}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <Card
        title="Discovered activities"
        hint="Observed values, measured from the log. These are not queueing-theory results — those come next, on the Discovered Model page."
      >
        <DataTable
          rows={d.activities}
          rowKey={(a) => a.id}
          emphasiseRow={(a) => a.id === d.bottleneckActivityId}
          columns={[
            { key: 'n', header: 'Activity', align: 'left', render: (a) => a.name },
            { key: 'x', header: 'Executions', render: (a) => num(a.executions, 0), sortValue: (a) => a.executions },
            { key: 'c', header: 'Cases', render: (a) => num(a.cases, 0), sortValue: (a) => a.cases },
            {
              key: 'v',
              header: 'Visits/case',
              title: 'Above 1 means cases come back to this activity',
              render: (a) => num(a.visitsPerCase, 3),
              sortValue: (a) => a.visitsPerCase,
            },
            { key: 'sm', header: 'Service mean (min)', render: (a) => num(a.serviceMeanMinutes, 2), sortValue: (a) => a.serviceMeanMinutes },
            { key: 'sd', header: 'Service sd', render: (a) => num(a.serviceSdMinutes, 2) },
            {
              key: 'cv',
              header: 'CV',
              title: 'Coefficient of variation — determines the fitted distribution family',
              render: (a) => num(a.serviceCV, 3),
              sortValue: (a) => a.serviceCV,
            },
            { key: 'lam', header: 'λ observed (/h)', render: (a) => num(a.lambdaObservedPerHour, 3), sortValue: (a) => a.lambdaObservedPerHour },
            { key: 'mu', header: 'μ observed (/h/srv)', render: (a) => num(a.muObservedPerHour, 3) },
            {
              key: 'sv',
              header: 'Servers (est.)',
              title: 'Maximum simultaneous executions observed — a lower bound on real capacity',
              render: (a) => num(discoveredServers[a.id] ?? a.maxConcurrency, 0),
            },
            { key: 'u', header: 'Utilisation', render: (a) => pct(a.utilizationObserved), sortValue: (a) => a.utilizationObserved },
            { key: 'w', header: 'Wait mean (min)', render: (a) => num(a.observedWaitMeanMinutes, 2), sortValue: (a) => a.observedWaitMeanMinutes },
            { key: 'sl', header: 'Self-loops', render: (a) => (a.selfLoops > 0 ? num(a.selfLoops, 0) : '—') },
          ]}
          caption={
            bottleneck
              ? `Highest observed utilisation: ${bottleneck.name} at ${pct(bottleneck.utilizationObserved)}.`
              : undefined
          }
        />
      </Card>

      <div className="grid cols-2">
        <Card title="Observed utilisation" hint="Busy server-time divided by available server-time, per activity.">
          <HorizontalBars
            unit="observed utilisation"
            labelWidth={150}
            barHeight={15}
            gap={6}
            max={1}
            formatValue={(v) => pct(v)}
            data={d.activities.map((a) => ({
              key: a.id,
              label: a.name,
              value: Math.min(1, a.utilizationObserved),
              color: a.id === d.bottleneckActivityId ? 'var(--status-critical)' : 'var(--series-1)',
              detail: [
                { label: 'Executions', value: num(a.executions, 0) },
                { label: 'Servers assumed', value: num(discoveredServers[a.id] ?? a.maxConcurrency, 0) },
              ],
            }))}
          />
        </Card>

        <Card title="Observed waiting time" hint="Gap between the previous activity completing and this one starting.">
          <HorizontalBars
            unit="minutes waited per visit"
            labelWidth={150}
            barHeight={15}
            gap={6}
            formatValue={(v) => num(v, 2)}
            data={[...d.activities]
              .sort((a, b) => b.observedWaitMeanMinutes - a.observedWaitMeanMinutes)
              .map((a) => ({
                key: a.id,
                label: a.name,
                value: a.observedWaitMeanMinutes,
                detail: [
                  { label: 'Max wait', value: `${num(a.observedWaitMaxMinutes, 1)} min` },
                  { label: 'Observations', value: num(a.waitObservations, 0) },
                ],
              }))}
          />
        </Card>
      </div>

      <Card
        title="Directly-follows graph"
        hint="Every observed transition, with the probability it implies. Terminations are counted as outflow, which is what makes each activity's probabilities sum to 1."
      >
        <DataTable
          rows={d.edges}
          rowKey={(e) => `${e.from}>>${e.to}`}
          columns={[
            { key: 'f', header: 'From', align: 'left', render: (e) => nameOf(e.from) },
            { key: 't', header: 'To', align: 'left', render: (e) => nameOf(e.to) },
            { key: 'c', header: 'Observed', render: (e) => num(e.count, 0), sortValue: (e) => e.count },
            { key: 'p', header: 'Probability', render: (e) => pct(e.probability, 2), sortValue: (e) => e.probability },
            { key: 'g', header: 'Mean gap (min)', render: (e) => num(e.meanGapMinutes, 2) },
            {
              key: 'l',
              header: 'Type',
              align: 'left',
              render: (e) =>
                e.isLoopBack ? (
                  <span className="status serious">rework / loop back</span>
                ) : (
                  <span className="muted">forward</span>
                ),
            },
          ]}
        />
        <div className="formula">
          Cases start at{' '}
          {d.startActivities.map((s) => `${s.name} (${s.count})`).join(', ')} and end at{' '}
          {d.endActivities.map((s) => `${s.name} (${s.count})`).join(', ')}.
        </div>
      </Card>

      <div className="grid cols-2">
        <Card
          title="Loops and rework"
          hint="A cycle in the directly-follows graph means cases return to an activity they already visited."
        >
          {d.loops.length === 0 ? (
            <EmptyState>No loops found — every case moves strictly forward.</EmptyState>
          ) : (
            <DataTable
              rows={d.loops}
              rowKey={(l) => l.activities.join('|')}
              columns={[
                {
                  key: 'a',
                  header: 'Loop',
                  align: 'left',
                  render: (l) =>
                    l.kind === 'self'
                      ? `${nameOf(l.activities[0] as string)} repeats`
                      : l.activities.map(nameOf).join(' ⇄ '),
                },
                { key: 'k', header: 'Kind', align: 'left', render: (l) => l.kind },
                { key: 'c', header: 'Cases affected', render: (l) => num(l.cases, 0) },
                { key: 's', header: 'Share of cases', render: (l) => pct(l.share, 1) },
                { key: 'n', header: 'Traversals', render: (l) => num(l.count, 0) },
              ]}
            />
          )}
        </Card>

        <Card title="Path variants" hint="Distinct end-to-end routes through the process.">
          <DataTable
            rows={d.variants.slice(0, 20)}
            rowKey={(v) => v.sequence.join('>')}
            maxHeight={300}
            columns={[
              { key: 's', header: 'Path', align: 'left', render: (v) => v.sequence.join(' → ') },
              { key: 'c', header: 'Cases', render: (v) => num(v.count, 0) },
              { key: 'p', header: 'Share', render: (v) => pct(v.share, 1) },
              { key: 'n', header: 'Steps', render: (v) => v.sequence.length },
            ]}
            caption={
              d.variants.length > 20 ? `Showing the 20 most common of ${d.variants.length} variants.` : undefined
            }
          />
        </Card>
      </div>

      <Card
        title="Assumptions — what the log could NOT determine"
        hint="Each one says why it had to be assumed. Server counts are editable here because correcting them changes every queueing result downstream."
      >
        <DataTable
          rows={d.assumptions}
          rowKey={(a) => a.id}
          columns={[
            { key: 'l', header: 'Assumption', align: 'left', render: (a) => a.label },
            {
              key: 'v',
              header: 'Value',
              render: (a) =>
                a.id.startsWith('servers:') && a.activityId ? (
                  <input
                    type="number"
                    min={1}
                    step={1}
                    style={{ width: 76 }}
                    value={
                      discoveredServers[a.activityId] ??
                      (typeof a.value === 'number' ? a.value : 1)
                    }
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isNaN(v) && v >= 1) setDiscoveredServers(a.activityId as string, v);
                    }}
                  />
                ) : (
                  <span className="mono">{String(a.value)}</span>
                ),
            },
            { key: 'u', header: 'Unit', align: 'left', render: (a) => a.unit },
            { key: 'w', header: 'Why it is an assumption', align: 'left', render: (a) => a.why },
          ]}
        />
      </Card>

      <Card title="Arrival process" hint="Estimated from the gaps between case start times.">
        <DataTable
          rows={[
            { k: 'Inter-arrival gaps observed', v: num(d.interArrival.count, 0), u: 'gaps' },
            { k: 'Mean inter-arrival time', v: num(d.interArrival.meanMinutes, 3), u: 'minutes' },
            { k: 'Standard deviation', v: num(d.interArrival.sdMinutes, 3), u: 'minutes' },
            { k: 'Coefficient of variation', v: num(d.interArrival.cv, 3), u: '—' },
            { k: 'Arrival rate λ', v: num(d.interArrival.lambdaPerHour, 4), u: 'cases/hour' },
            { k: 'Fitted Kendall symbol', v: d.interArrival.symbol, u: 'arrival process' },
            { k: 'Observation window', v: minutes(d.observationWindowMinutes), u: '' },
          ]}
          rowKey={(r) => r.k}
          columns={[
            { key: 'k', header: 'Measure', align: 'left', render: (r) => r.k },
            { key: 'v', header: 'Value', render: (r) => r.v },
            { key: 'u', header: 'Unit', align: 'left', render: (r) => r.u },
          ]}
        />
      </Card>

      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <button className="btn primary" onClick={() => navigate('discovered')}>
          Build the queueing model →
        </button>
        <button className="btn" onClick={() => navigate('alphacompare')}>
          Compare Alpha vs Alpha+ (Task 9) →
        </button>
        <span className="small muted">
          Evaluate how loop-handling differences between Alpha and Alpha+ impact queue lead times and model soundness.
        </span>
      </div>
    </div>
  );
}
