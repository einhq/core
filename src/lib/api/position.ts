/** A node's shape on the ground: a point, a circle (with `radius`, in metres) or an outline. */
export type PositionShape = { lat: number; lng: number; radius?: number; polygon?: { lat: number; lng: number }[] };

/**
 * One path as `position-get` found it: its name and type, and its shape when it has one — none
 * yet (a location awaiting geocoding, a picture without GPS) leaves `position` out. A path the
 * caller cannot read has only `error`.
 */
export type NodePosition = { path: string; name?: string; type?: string; position?: PositionShape; error?: string };

/** `position-get`'s answer: one entry per path, in the order asked. */
export type PositionListing = { nodes: NodePosition[] };
