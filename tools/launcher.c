// launcher.c — the main executable of "Portal Met Bridge.app".
//
// It does one thing: run Contents/Helpers/launcher.sh (the real launcher, a
// bash script) with the same arguments. It exists because Apple's notarization
// requires the main executable of an app to be a signed Mach-O binary with the
// hardened runtime, and a shell script cannot be signed that way. Unsigned
// builds (tools/package-macos.sh on Linux, or without a C compiler) use the
// script itself as the main executable and work the same, minus notarization.
//
// Built by tools/package-macos.sh:
//   cc -O2 -Wall -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 -o "…/Contents/MacOS/portal-met-bridge" tools/launcher.c
// The Linux branch below only exists so the file can be compiled and tested
// there; it is not what ships.
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

static int executable_path(char *buf, size_t size) {
#ifdef __APPLE__
  uint32_t n = (uint32_t)size;
  if (_NSGetExecutablePath(buf, &n) != 0) return -1;
  return 0;
#else
  ssize_t n = readlink("/proc/self/exe", buf, size - 1);
  if (n < 0) return -1;
  buf[n] = '\0';
  return 0;
#endif
}

int main(int argc, char **argv) {
  char exe[PATH_MAX], real[PATH_MAX], script[PATH_MAX];
  if (executable_path(exe, sizeof exe) != 0 || !realpath(exe, real)) {
    fprintf(stderr, "portal-met-bridge launcher: cannot find my own path\n");
    return 1;
  }
  char *slash = strrchr(real, '/'); // …/Contents/MacOS/portal-met-bridge → …/Contents/MacOS
  if (!slash) return 1;
  *slash = '\0';
  if (snprintf(script, sizeof script, "%s/../Helpers/launcher.sh", real) >= (int)sizeof script) return 1;
  char **args = calloc((size_t)argc + 3, sizeof *args);
  if (!args) return 1;
  args[0] = "bash";
  args[1] = script;
  for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
  args[argc + 1] = NULL;
  execv("/bin/bash", args);
  perror("portal-met-bridge launcher: /bin/bash");
  return 1;
}
