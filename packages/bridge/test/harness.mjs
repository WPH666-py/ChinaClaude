/**
 * Shared teardown for the bridge test suites.
 *
 * WHY THIS EXISTS — a suite that passes every check can still exit non-zero on Windows:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
 *   exit 0xC0000409
 *
 * `process.exit()` tears the runtime down in the same tick that undici is still closing its
 * keep-alive socket to the bridge. On Windows that races libuv's async-handle teardown and trips a
 * fail-fast assertion. It is timing-dependent, so it punishes the FASTEST suite: `permission-mode`
 * sends no model turns, so it reliably lost the race and reported 9/9 checks passed with a
 * non-zero exit — a gate that cries wolf.
 *
 * Measured on this machine (node v24.9.0): 0/4 clean at a 0 ms settle, 0/4 at 25 ms, 4/4 at
 * 100 ms and above. A magic sleep would work but hides the reason and would break on a slower
 * machine. Setting `process.exitCode` and letting the loop DRAIN is deterministic (6/6 clean, no
 * delay) because the socket finishes closing before the runtime shuts down.
 *
 * `finish()` therefore never calls `process.exit()`. The unref'd timer is a hang guard only: it
 * cannot keep the loop alive, so a healthy run exits immediately, but a leaked handle cannot wedge
 * CI. The exit status is already committed by then, so the guard cannot change a verdict.
 */

/**
 * Kill a child and wait until it is actually reaped.
 *
 * 'close' rather than 'exit': 'exit' fires while the stdio pipes are still open, which leaves the
 * same class of mid-close handle the drain in `finish()` is avoiding.
 */
export function stopChild(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (child === null || child === undefined) {
      resolve()
      return
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

/**
 * Print the tally, commit the exit status, and let the event loop drain.
 *
 * @param {Array<{name: string, ok: boolean}>} results
 * @param {number} [hangGuardMs] how long to tolerate a leaked handle before leaving anyway
 */
export function finish(results, hangGuardMs = 5000) {
  const failed = results.filter((row) => !row.ok)
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
  if (failed.length > 0) {
    console.log('failures:')
    for (const row of failed) console.log('  - ' + row.name)
  }
  process.exitCode = failed.length > 0 ? 1 : 0
  // unref'd: cannot hold the loop open, only fires if something else already is.
  setTimeout(() => process.exit(process.exitCode ?? 0), hangGuardMs).unref()
}

/** Shared PASS/FAIL line, so every suite reports in the same shape. */
export function makeCheck(results) {
  return function check(name, ok, detail = '') {
    results.push({ name, ok: ok === true })
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  }
}
