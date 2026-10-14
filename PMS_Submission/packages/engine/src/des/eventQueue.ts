/**
 * Event calendar — requirement 2 ("Use an event calendar / priority queue
 * ordered by simulation time").
 *
 * Implemented as a binary min-heap keyed on (time, sequence). The sequence
 * number is the insertion order and breaks ties between events scheduled for
 * the identical simulation instant. Without it, heap sift order would decide
 * which of two simultaneous events runs first, and that order can change with
 * unrelated edits — which would silently break the reproducibility guarantee
 * in requirement 2. With it, simultaneous events always fire in the order they
 * were scheduled.
 */

export type EventKind =
  /** An external vehicle enters the system. */
  | 'ARRIVAL'
  /** A server finishes processing a vehicle. */
  | 'SERVICE_COMPLETE'
  /** A machine fails and its server becomes unavailable. */
  | 'BREAKDOWN'
  /** A failed machine is repaired and returns to service. */
  | 'REPAIR_COMPLETE'
  /** Warm-up ends; all statistics are cleared (requirement 45). */
  | 'WARMUP_END'
  /** End of the simulated horizon. */
  | 'END_OF_HORIZON';

export interface SimEvent {
  /** Simulation time in minutes at which the event fires. */
  time: number;
  kind: EventKind;
  /** Station the event concerns, if any. */
  stationId?: string;
  /** Server index within the station, if any. */
  serverIndex?: number;
  /** Vehicle the event concerns, if any. */
  vehicleId?: number;
  /**
   * Validity token. A server stores the token of the event it is currently
   * waiting on; an event whose token no longer matches has been superseded
   * (e.g. a service completion cancelled by a machine breakdown) and is
   * discarded when popped. This is the standard way to "cancel" an event in a
   * heap without paying for arbitrary removal.
   */
  token?: number;
  /** Insertion order, assigned by the queue. */
  seq: number;
}

export class EventQueue {
  private heap: SimEvent[] = [];
  private counter = 0;

  get size(): number {
    return this.heap.length;
  }

  /** Next event time without removing it, or null when the calendar is empty. */
  peekTime(): number | null {
    const top = this.heap[0];
    return top ? top.time : null;
  }

  peek(): SimEvent | null {
    return this.heap[0] ?? null;
  }

  schedule(ev: Omit<SimEvent, 'seq'>): SimEvent {
    const full: SimEvent = { ...ev, seq: this.counter++ };
    this.heap.push(full);
    this.siftUp(this.heap.length - 1);
    return full;
  }

  pop(): SimEvent | null {
    const n = this.heap.length;
    if (n === 0) return null;
    const top = this.heap[0] as SimEvent;
    const last = this.heap.pop() as SimEvent;
    if (n > 1) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  clear(): void {
    this.heap = [];
    this.counter = 0;
  }

  /** Events currently on the calendar, in time order. Debug/inspection only. */
  snapshot(): SimEvent[] {
    return [...this.heap].sort(compare);
  }

  private siftUp(i: number): void {
    const item = this.heap[i] as SimEvent;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = this.heap[parent] as SimEvent;
      if (compare(item, p) >= 0) break;
      this.heap[i] = p;
      i = parent;
    }
    this.heap[i] = item;
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    const item = this.heap[i] as SimEvent;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= n) break;
      const right = left + 1;
      let child = left;
      if (right < n && compare(this.heap[right] as SimEvent, this.heap[left] as SimEvent) < 0) {
        child = right;
      }
      const c = this.heap[child] as SimEvent;
      if (compare(c, item) >= 0) break;
      this.heap[i] = c;
      i = child;
    }
    this.heap[i] = item;
  }
}

/** Order by time, then by insertion sequence. */
function compare(a: SimEvent, b: SimEvent): number {
  if (a.time !== b.time) return a.time - b.time;
  return a.seq - b.seq;
}
