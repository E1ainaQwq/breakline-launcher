using System;
using System.Runtime.InteropServices;

internal static class MemoryCleanup
{
    private const int SystemMemoryListInformation = 0x50;
    private const int MemoryEmptyWorkingSets = 2;
    private const int MemoryFlushModifiedList = 3;

    [DllImport("ntdll.dll", EntryPoint = "NtSetSystemInformation")]
    private static extern int NtSetSystemInformation(int informationClass, ref int information, int informationLength);

    private static int Apply(int command)
    {
        return NtSetSystemInformation(SystemMemoryListInformation, ref command, sizeof(int));
    }

    private static int Main(string[] args)
    {
        // Deliberately accept no switches, paths, scripts, or caller-selected memory-list operation.
        if (args == null || args.Length != 0) return 10;
        int emptyWorkingSets = Apply(MemoryEmptyWorkingSets);
        int flushModifiedList = Apply(MemoryFlushModifiedList);
        if (emptyWorkingSets != 0 && flushModifiedList != 0) return 22;
        if (emptyWorkingSets != 0) return 20;
        if (flushModifiedList != 0) return 21;
        return 0;
    }
}
