import { CapacityGate } from "@aihot/backend/lib/capacity";

// Cards and tall posters share one native-render slot, with no unbounded sharp/layout queue.
// Disk hits and identical-key coalescing are handled before this admission gate.
export const ogRenderCapacity = new CapacityGate(1, 0);
