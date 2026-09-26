/**
 * HOW A COMMAND THAT STOPPED ON AN ERROR SAYS SO ON THE TERMINAL: the message, and
 * not the stack.
 *
 * The errors a command most often stops on are CONFIGURATION REFUSALS, and those are
 * written to be read: they name the flag, the variable and the command that does own
 * the input. Printed as an `Error` object, the message is followed by a stack through
 * the resolver that buries it, which is what `cli.ts` and `fetch` already avoid. A
 * caller that needs the error itself injects its own `error` and receives the
 * object unchanged; the whole error, stack included, also goes to the `etherfold`
 * logger for whoever enables it.
 */
export function printMessage(...args: unknown[]): void {
	console.error(...args.map((arg) => (arg instanceof Error ? arg.message : arg)));
}
