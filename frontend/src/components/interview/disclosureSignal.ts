import { createContext } from 'react';

/** "Expand all" / "Collapse all": every disclosure below the provider follows it each time `tick` changes. */
export interface DisclosureSignal {
  open: boolean;
  tick: number;
}

export const DisclosureSignalContext = createContext<DisclosureSignal>({ open: false, tick: 0 });
