export type Announcement = { id: string; title: string; body: string; date: string; version?: string; tag: string; tone: string }
export type AnnouncementResult = { items: Announcement[]; cached: boolean; error?: string }
