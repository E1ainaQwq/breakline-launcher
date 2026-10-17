const GC_FLAG = /^ *-XX:[+-]?(Use\w+GC|ZGenerational|UseCompactObjectHeaders|G1\w+Percent|G1\w+Size|(Max|Min)(GCPauseMillis|HeapFreeRatio)|PerfDisableSharedMem)(?:=.*)?$/i

/** Remove existing GC family flags before applying one selected profile. */
export function stripGcFlags(args: string[]): string[] {
  return args.filter(arg => !GC_FLAG.test(arg))
}

/** Tuning profile from PCL2 2.13.1.1, conditioned on the detected Java major. */
export function tunedG1Args(javaMajor: number): string[] {
  const out = ['-XX:+UnlockExperimentalVMOptions']
  if (javaMajor >= 24) out.push('-XX:+UseCompactObjectHeaders')
  out.push(
    '-XX:+UseG1GC',
    '-XX:G1NewSizePercent=20',
    '-XX:G1ReservePercent=20',
    '-XX:G1HeapRegionSize=32M',
    '-XX:MaxGCPauseMillis=50',
    '-XX:+PerfDisableSharedMem'
  )
  if (javaMajor <= 7) out.push('-XX:MaxPermSize=512m')
  if (javaMajor === 8) out.push('-XX:+ParallelRefProcEnabled')
  if (javaMajor >= 12) out.push('-XX:MinHeapFreeRatio=25', '-XX:MaxHeapFreeRatio=40')
  return out
}

export function runGcProfileSelfTest(): number {
  let failed = 0
  const check = (label: string, ok: boolean): void => {
    console.log(`    ${ok ? '✓' : '✗'} ${label}`)
    if (!ok) failed++
  }
  console.log('\n── GC 参数包')
  const template = ['-XX:+UseG1GC', '-XX:G1ReservePercent=15', '-XX:MaxGCPauseMillis=50', '-XX:MaxMetaspaceSize=1G', '-javaagent:auth.jar', '-Dkeep=1']
  const stripped = stripGcFlags(template)
  check('剥离 G1/暂停参数，保留普通 JVM 参数与登录 agent', stripped.join('|') === '-XX:MaxMetaspaceSize=1G|-javaagent:auth.jar|-Dkeep=1')
  const java17 = tunedG1Args(17)
  check('Java 17 实验参数解锁置首且 reserve=20', java17[0] === '-XX:+UnlockExperimentalVMOptions' && java17.includes('-XX:G1ReservePercent=20'))
  check('Java 8 条件参数只出现在 Java 8', tunedG1Args(8).includes('-XX:+ParallelRefProcEnabled') && !java17.includes('-XX:+ParallelRefProcEnabled'))
  check('Java 24 压缩对象头条件参数', tunedG1Args(24).includes('-XX:+UseCompactObjectHeaders') && !java17.includes('-XX:+UseCompactObjectHeaders'))
  return failed === 0 ? 0 : 1
}
