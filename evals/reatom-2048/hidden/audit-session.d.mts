export type AuditFinding = {
  toolCallId: string
  toolName: string
  model: string | null
  reason: string
  excerpt: string
}

export type AuditSessionResult = {
  ok: boolean
  skipped?: string
  toolCalls: number
  violations: AuditFinding[]
  warnings: AuditFinding[]
  sources: string[]
}

export function auditSession(workspaceDir: string): AuditSessionResult
