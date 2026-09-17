/**
 * Event Log Import — Task 7, step 1.
 *
 * Accepts a CSV event log by file, drag-and-drop or paste, and reports exactly
 * what it understood: which column it matched to which field, what time format
 * it detected, what time zero corresponds to, and every row it could not use
 * and why. Nothing is discarded silently.
 *
 * The "generate from the current model" button is there so the feature can be
 * demonstrated without hunting for a file — and because a log produced by a
 * model whose parameters are known is the honest way to check that discovery
 * recovers what it should.
 */

import { useRef, useState } from 'react';
import { eventLogCsvFromVehicles, runSimulation, type SystemModel } from '@vmq/engine';
import { useStore } from '../state/store';
import { Card, DataTable, EmptyState, Kpi, Notice } from '../components/primitives';
import { downloadFile } from '../lib/api';
import { minutes, num } from '../lib/format';

const EXAMPLE = `CaseID,Activity,Start,Complete
V001,Body Shop,08:00,08:15
V001,Paint,08:17,08:35
V001,Assembly,08:38,09:00
V001,Inspection,09:02,09:10
V002,Body Shop,08:05,08:20
V002,Paint,08:36,08:55
V002,Assembly,09:00,09:24
V002,Inspection,09:26,09:34
V002,Rework,09:36,09:52
V002,Inspection,09:54,10:02
V003,Body Shop,08:22,08:38
V003,Paint,08:56,09:16
V003,Assembly,09:24,09:46
V003,Inspection,09:48,09:56`;

export function EventLogPage({ navigate }: { navigate: (p: string) => void }) {
  const { model, eventLog, eventLogSource, discoveryError, loadEventLog, clearEventLog, notify } =
    useStore();
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => loadEventLog(String(reader.result ?? ''), file.name);
    reader.onerror = () => notify(`Could not read ${file.name}.`);
    reader.readAsText(file);
  };

  const generateFromModel = () => {
    const m: SystemModel = {
      ...model,
      simulation: {
        ...model.simulation,
        collectVehicleTraces: true,
        maxTraces: 400,
        terminationMode: 'drain',
      },
    };
    const sim = runSimulation(m);
    const csv = eventLogCsvFromVehicles(sim.traces, { maxCases: 300 });
    loadEventLog(csv, `${model.name} (simulated)`);
  };

  return (
    <div className="stack">
      <p className="page-intro">
        Import an event log of what actually happened on the line. The next pages mine it for the
        process structure, turn that into a queueing model, and simulate it — so the flow is
        <strong> event log → discovery → queue model → simulation → results</strong>.
      </p>

      <Card
        title="Import"
        hint="CSV with a case id, an activity, a start time and (ideally) a completion time. Column names are matched by synonym, so case_id / task / begin / finish all work."
        actions={
          eventLog ? (
            <button className="btn sm danger" onClick={clearEventLog}>
              Clear log
            </button>
          ) : null
        }
      >
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) readFile(f);
          }}
          style={{
            border: `1px dashed ${dragging ? 'var(--series-1)' : 'var(--border-strong)'}`,
            borderRadius: 4,
            padding: 18,
            textAlign: 'center',
            background: dragging ? 'var(--surface-2)' : 'transparent',
          }}
        >
          <div style={{ marginBottom: 8 }}>Drop a .csv file here, or</div>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={() => fileRef.current?.click()}>
              Choose a file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) readFile(f);
                e.target.value = '';
              }}
            />
            <button className="btn" onClick={() => setText(EXAMPLE)}>
              Load the example from the brief
            </button>
            <button
              className="btn"
              onClick={generateFromModel}
              title="Simulate the current system and export the event log it produces"
            >
              Generate from the current model
            </button>
          </div>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label>…or paste the CSV directly</label>
          <textarea
            rows={8}
            className="mono"
            style={{ fontSize: 11 }}
            value={text}
            placeholder={EXAMPLE}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="row">
          <button
            className="btn primary"
            disabled={text.trim() === ''}
            onClick={() => loadEventLog(text, 'pasted text')}
          >
            Parse pasted log
          </button>
        </div>

        {discoveryError ? (
          <Notice kind="error" title="The log could not be read">
            {discoveryError}
          </Notice>
        ) : null}
      </Card>

      {!eventLog ? (
        <EmptyState>No event log loaded yet.</EmptyState>
      ) : (
        <>
          <div className="grid cols-4">
            <Kpi label="Cases" value={num(eventLog.caseIds.length, 0)} basis="derived" sub="distinct case ids" />
            <Kpi label="Events" value={num(eventLog.rows.length, 0)} basis="derived" sub="activity instances" />
            <Kpi
              label="Activities"
              value={num(eventLog.activityNames.length, 0)}
              basis="derived"
              sub={eventLog.activityNames.slice(0, 3).join(', ')}
            />
            <Kpi
              label="Observed span"
              value={minutes(Math.max(...eventLog.rows.map((r) => r.complete)))}
              basis="derived"
              sub={eventLog.originLabel}
              small
            />
          </div>

          <Card
            title="How the file was interpreted"
            hint="Check this before trusting anything downstream — a mis-matched column produces a confident but wrong model."
          >
            <DataTable
              rows={[
                { f: 'Case id', c: eventLog.columns.caseId },
                { f: 'Activity', c: eventLog.columns.activity },
                { f: 'Start time', c: eventLog.columns.start },
                { f: 'Completion time', c: eventLog.columns.complete ?? '— not present' },
                { f: 'Resource', c: eventLog.columns.resource ?? '— not present' },
                { f: 'Time format detected', c: eventLog.timeFormat },
                { f: 'Time origin', c: eventLog.originLabel },
                { f: 'Source', c: eventLogSource ?? '—' },
              ]}
              rowKey={(r) => r.f}
              columns={[
                { key: 'f', header: 'Field', align: 'left', render: (r) => r.f },
                { key: 'c', header: 'Matched to', align: 'left', render: (r) => <span className="mono small">{r.c}</span> },
              ]}
            />
          </Card>

          {eventLog.warnings.length > 0 ? (
            <Notice kind="warn" title="Notes on this log">
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {eventLog.warnings.map((w, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>
                    {w}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}

          {eventLog.rejected.length > 0 ? (
            <Card title={`${eventLog.rejected.length} rows could not be used`} hint="Listed in full — nothing is dropped silently.">
              <DataTable
                rows={eventLog.rejected}
                rowKey={(r) => String(r.line)}
                maxHeight={240}
                columns={[
                  { key: 'l', header: 'Line', render: (r) => r.line },
                  { key: 'w', header: 'Reason', align: 'left', render: (r) => r.reason },
                  { key: 'r', header: 'Content', align: 'left', render: (r) => <span className="mono small">{r.raw}</span> },
                ]}
              />
            </Card>
          ) : null}

          <Card
            title="Parsed events"
            hint="Times converted to minutes from the log origin, which is the unit the rest of the engine uses."
            actions={
              <button
                className="btn sm"
                onClick={() => {
                  const header = 'CaseID,Activity,StartMinutes,CompleteMinutes,DurationMinutes';
                  const body = eventLog.rows.map(
                    (r) => `${r.caseId},${r.activity},${r.start.toFixed(3)},${r.complete.toFixed(3)},${(r.complete - r.start).toFixed(3)}`,
                  );
                  downloadFile('parsed-event-log.csv', [header, ...body].join('\r\n'), 'text/csv');
                }}
              >
                Export parsed
              </button>
            }
          >
            <DataTable
              rows={eventLog.rows.slice(0, 500)}
              rowKey={(r) => `${r.caseId}-${r.line}`}
              maxHeight={380}
              columns={[
                { key: 'c', header: 'Case', align: 'left', render: (r) => r.caseId },
                { key: 'a', header: 'Activity', align: 'left', render: (r) => r.activity },
                { key: 's', header: 'Start (min)', render: (r) => num(r.start, 2) },
                { key: 'e', header: 'Complete (min)', render: (r) => num(r.complete, 2) },
                { key: 'd', header: 'Duration (min)', render: (r) => num(r.complete - r.start, 2) },
                ...(eventLog.columns.resource
                  ? [
                      {
                        key: 'r',
                        header: 'Resource',
                        align: 'left' as const,
                        render: (r: (typeof eventLog.rows)[number]) => r.resource ?? '—',
                      },
                    ]
                  : []),
              ]}
              caption={
                eventLog.rows.length > 500
                  ? `Showing the first 500 of ${eventLog.rows.length} events.`
                  : undefined
              }
            />
          </Card>

          <div className="row">
            <button className="btn primary" onClick={() => navigate('discovery')}>
              Discover the process →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
