// Mirrors backend/walkthru/schema.py and docs/CONTRACTS.md. All units feet;
// origin = footprint top-left; x east, y south. In 3D: plan x -> three x, plan y -> three z.

export type RoomType =
  | "living" | "kitchen" | "dining" | "bedroom" | "primary_bedroom" | "bathroom"
  | "office" | "laundry" | "entry" | "hall" | "closet";

export interface Footprint { width_ft: number; depth_ft: number }
export interface Point { x: number; y: number }

export interface RoomSpec {
  id: string; type: RoomType; name: string; target_sqft: number; adjacent_to: string[];
}
export interface Room extends RoomSpec { x: number; y: number; w: number; h: number }

export interface Door { between: [string, string] | string[]; x: number; y: number; width_ft: number }
export interface Window { room: string; wall: "north" | "south" | "east" | "west"; offset_ft: number; width_ft: number }
export interface Check { rule: string; pass: boolean; message: string }

export interface Layout {
  footprint: Footprint; entrance: Point; rooms: Room[]; doors: Door[];
  windows: Window[]; checks: Check[]; requested_sqft?: number | null;
}

export interface RoomProgram { requested_sqft: number; aspect_ratio: number; rooms: RoomSpec[]; notes: string }
export interface FixRound { round: number; failed: Check[]; note: string }

export interface GenerateResponse {
  layout: Layout; program: RoomProgram; rounds: FixRound[];
  attempts: number; elapsed_s: number; cached: boolean;
}

// POST /api/chat
export type ChatAction = "ask" | "answer" | "edit" | "generate";
export interface ChatMessage { role: "user" | "assistant"; content: string }
export interface ChatRequest { messages: ChatMessage[]; program: RoomProgram | null; layout: Layout | null }
export interface ChatResponse {
  action: ChatAction;
  reply: string;
  options: string[];                 // 0-4 tappable answers / suggested next messages
  brief: string | null;              // "generate": pass to /api/generate as {prompt: brief}
  result: GenerateResponse | null;   // "edit": the edited plan
}

export const EYE_HEIGHT_FT = 5.5;
export const WALL_HEIGHT_FT = 9;
export const EXTERIOR = "exterior";
