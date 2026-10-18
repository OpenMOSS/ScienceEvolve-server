// The native Windows Codex .bat shim uses cmd's legacy argument parsing,
// which loses multiline patches. Pass the UTF-16 argv value straight to the
// official patch engine; also accept UTF-8 stdin for shell here-strings.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

public static class OpenFarsApplyPatch {
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') { result.Append('\\', slashes * 2 + 1); result.Append(ch); }
      else { result.Append('\\', slashes); result.Append(ch); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  public static int Main(string[] args) {
    try {
      Console.InputEncoding = new UTF8Encoding(false);
      Console.OutputEncoding = new UTF8Encoding(false);
      string patch = args.Length > 0 ? string.Join(" ", args) : Console.In.ReadToEnd();
      patch = patch.TrimStart('\uFEFF', '\r', '\n').TrimEnd('\r', '\n');
      if (!patch.StartsWith("*** Begin Patch") || !patch.EndsWith("*** End Patch")) {
        Console.Error.WriteLine("apply_patch requires a complete UTF-8 patch argument or stdin"); return 1;
      }
      string directory = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
      string executable = File.ReadAllText(Path.Combine(directory, "openfars-codex-path.txt")).Trim();
      var start = new ProcessStartInfo(executable, "--codex-run-as-apply-patch " + Quote(patch));
      start.UseShellExecute = false; start.CreateNoWindow = true;
      start.RedirectStandardOutput = true; start.RedirectStandardError = true;
      start.StandardOutputEncoding = new UTF8Encoding(false);
      start.StandardErrorEncoding = new UTF8Encoding(false);
      using (var child = new Process()) {
        child.StartInfo = start;
        child.OutputDataReceived += (sender, line) => { if (line.Data != null) Console.Out.WriteLine(line.Data); };
        child.ErrorDataReceived += (sender, line) => { if (line.Data != null) Console.Error.WriteLine(line.Data); };
        child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine();
        child.WaitForExit(); return child.ExitCode;
      }
    } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
  }
}
