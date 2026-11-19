using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Windows.Devices.Bluetooth.GenericAttributeProfile;

// The WinRT callback thread never enters PowerShell. Capture changes while stdin is
// idle or a notification is in flight; the worker alone owns routing and stdout.
public sealed class GattSubscriptions : IDisposable
{
    public sealed class Changes
    {
        public readonly HashSet<string> Mouse = new HashSet<string>(StringComparer.Ordinal);
        public readonly HashSet<string> Keyboard = new HashSet<string>(StringComparer.Ordinal);
        public readonly HashSet<string> Absolute = new HashSet<string>(StringComparer.Ordinal);
        public bool Any { get { return Mouse.Count + Keyboard.Count + Absolute.Count != 0; } }
    }

    private readonly object gate = new object();
    private readonly AutoResetEvent changed = new AutoResetEvent(false);
    private readonly Dictionary<GattLocalCharacteristic, HashSet<string>> previous =
        new Dictionary<GattLocalCharacteristic, HashSet<string>>();
    private readonly Dictionary<GattLocalCharacteristic, Dictionary<string,GattSubscribedClient>> recipients =
        new Dictionary<GattLocalCharacteristic, Dictionary<string,GattSubscribedClient>>();
    private readonly Dictionary<GattSession, string> sessions = new Dictionary<GattSession, string>();
    private readonly GattLocalCharacteristic mouse, keyboard, absolute;
    private Changes changes = new Changes();
    private bool closed;

    public GattSubscriptions(GattLocalCharacteristic mouse, GattLocalCharacteristic keyboard, GattLocalCharacteristic absolute)
    {
        this.mouse = mouse;
        this.keyboard = keyboard;
        this.absolute = absolute;
        try {
            foreach (var report in new[] {mouse, keyboard, absolute}) {
                lock (gate) {
                    previous[report] = new HashSet<string>(StringComparer.Ordinal);
                    report.SubscribedClientsChanged += OnChanged;
                    previous[report] = Snapshot(report);
                }
            }
        } catch {
            Dispose();
            throw;
        }
    }

    private HashSet<string> Snapshot(GattLocalCharacteristic report)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var active = new Dictionary<string,GattSubscribedClient>(StringComparer.Ordinal);
        var liveSessions = new HashSet<GattSession>();
        foreach (var client in report.SubscribedClients) {
            var session = client.Session;
            string id = session.DeviceId.Id;
            if (String.IsNullOrEmpty(id)) continue;
            if (report == mouse) {
                liveSessions.Add(session);
                if (!sessions.ContainsKey(session)) {
                    sessions[session] = id;
                    session.SessionStatusChanged += OnSessionChanged;
                }
            }
            if (session.SessionStatus == GattSessionStatus.Active) {
                ids.Add(id);
                active[id] = client;
            }
        }
        Dictionary<string,GattSubscribedClient> oldClients;
        if (recipients.TryGetValue(report, out oldClients)) {
            var affected = report == mouse ? changes.Mouse : report == keyboard ? changes.Keyboard : changes.Absolute;
            foreach (var current in active) {
                GattSubscribedClient old;
                if (oldClients.TryGetValue(current.Key,out old) && !Object.ReferenceEquals(old,current.Value))
                    affected.Add(current.Key);
            }
        }
        recipients[report] = active;
        if (report == mouse) {
            foreach (var session in new List<GattSession>(sessions.Keys)) {
                if (liveSessions.Contains(session)) continue;
                changes.Mouse.Add(sessions[session]);
                session.SessionStatusChanged -= OnSessionChanged;
                sessions.Remove(session);
            }
        }
        return ids;
    }

    private void OnSessionChanged(GattSession sender, GattSessionStatusChangedEventArgs args)
    {
        lock (gate) {
            string id;
            if (closed || !sessions.TryGetValue(sender, out id)) return;
            changes.Mouse.Add(id);
            changes.Keyboard.Add(id);
            changes.Absolute.Add(id);
            changed.Set();
        }
    }

    // Windows reports a collection change without identifying the affected client.
    // If transitions coalesced to the very same IDs, continuity cannot be proven.
    public static void Record(HashSet<string> before, HashSet<string> after, HashSet<string> invalidated)
    {
        if (before.SetEquals(after)) { invalidated.UnionWith(before); return; }
        foreach (string id in before) if (!after.Contains(id)) invalidated.Add(id);
        foreach (string id in after) if (!before.Contains(id)) invalidated.Add(id);
    }

    private void OnChanged(GattLocalCharacteristic sender, object args)
    {
        lock (gate) {
            if (closed) return;
            var affected = sender == mouse ? changes.Mouse : sender == keyboard ? changes.Keyboard : changes.Absolute;
            var before = previous[sender];
            try {
                var after = Snapshot(sender);
                Record(before, after, affected);
                previous[sender] = after;
            } catch {
                // A session can vanish while Windows enumerates its properties.
                affected.UnionWith(before);
                previous[sender] = new HashSet<string>(StringComparer.Ordinal);
            }
            changed.Set();
        }
    }

    public Changes Drain()
    {
        lock (gate) {
            var result = changes;
            changes = new Changes();
            return result;
        }
    }

    public static Task<string> ReadCommand() { return Task.Run(() => Console.ReadLine()); }
    public void Wait(Task<string> command)
    {
        WaitHandle.WaitAny(new[] { ((IAsyncResult)command).AsyncWaitHandle, changed });
    }

    public void Dispose()
    {
        lock (gate) {
            if (closed) return;
            closed = true;
        }
        foreach (var report in previous.Keys) report.SubscribedClientsChanged -= OnChanged;
        foreach (var session in sessions.Keys) session.SessionStatusChanged -= OnSessionChanged;
        changed.Dispose();
    }
}
