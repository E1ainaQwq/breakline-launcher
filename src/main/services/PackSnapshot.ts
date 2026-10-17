/** Both historical filename maps and the current public manifest are supported. */
export function packSnapshotFiles(raw: unknown): Record<string, string> {
  const files = (raw as { files?: unknown } | null)?.files
  const entries = Array.isArray(files)
    ? files.map(f => [f?.name, f?.sha256])
    : files && typeof files === 'object' ? Object.entries(files) : []
  const result: Record<string, string> = {}
  for (const [name, hash] of entries) {
    if (typeof name !== 'string' || !/^[^/\\]+\.jar$/i.test(name) ||
        typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash) || name in result) {
      throw new Error('整合包快照格式无效')
    }
    result[name] = hash.toLowerCase()
  }
  if (!entries.length) throw new Error('整合包快照为空')
  return result
}
