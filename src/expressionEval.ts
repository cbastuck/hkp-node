/**
 * The expressions a board writes — a Map's terms, a Filter's predicate — and
 * what evaluating one may reach.
 *
 * This is the boundary between a board, which somebody else may have written,
 * and the process it runs in: on a hosted server, everyone the server lets in.
 * It was the `expression-eval` package until its author stopped maintaining
 * it; it is kept here so that it is read and changed like the security code it
 * is (`docs/content/concepts/runtime.md`). Parsing is `jsep`'s, pinned.
 *
 * What an expression can do is what the scope it is given can do, and nothing
 * else:
 *
 * - **No way to code.** Nothing here compiles a string, and the routes to
 *   something that does — `constructor`, `prototype`, `__proto__`, and every
 *   other `__`-prefixed member — are refused by name, however the name is
 *   arrived at (`a.b`, `a["b"]`, `a[["b"]]`).
 * - **No assignment.** The grammar has none, so an expression reads and calls
 *   but never writes a property.
 * - **Only the scope.** A name resolves to the scope's own property or to
 *   nothing; what the scope inherits from `Object.prototype` is not a name.
 *
 * Twin of `hkp-frontend/src/runtime/browser/services/base/expressionEval.ts`;
 * the two are kept identical, so a term evaluates alike in either runtime.
 */
import jsep from "jsep";

export type Expression = jsep.Expression;

type Scope = Record<string, unknown>;

const BINARY: Record<string, (a: any, b: any) => unknown> = {
  "|": (a, b) => a | b,
  "^": (a, b) => a ^ b,
  "&": (a, b) => a & b,
  "==": (a, b) => a == b, // eslint-disable-line eqeqeq
  "!=": (a, b) => a != b, // eslint-disable-line eqeqeq
  "===": (a, b) => a === b,
  "!==": (a, b) => a !== b,
  "<": (a, b) => a < b,
  ">": (a, b) => a > b,
  "<=": (a, b) => a <= b,
  ">=": (a, b) => a >= b,
  "<<": (a, b) => a << b,
  ">>": (a, b) => a >> b,
  ">>>": (a, b) => a >>> b,
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "%": (a, b) => a % b,
};

const UNARY: Record<string, (a: any) => unknown> = {
  "-": (a) => -a,
  "+": (a) => +a,
  "~": (a) => ~a,
  "!": (a) => !a,
};

/** Members that lead from a value to the code behind it. */
const REFUSED_MEMBERS = new Set(["constructor", "prototype"]);

/** Parses an expression; throws on one that does not parse. */
export function parse(source: string): Expression {
  return jsep(source);
}

/** The member a key names, or a refusal when it names a way out. */
function memberKey(key: unknown): string | number {
  if (typeof key === "number") {
    return key;
  }
  // As a property access would read it: `a[["b"]]` is `a.b`.
  const name = String(key);
  if (REFUSED_MEMBERS.has(name) || name.startsWith("__")) {
    throw new Error(`Access to member "${name}" disallowed.`);
  }
  return name;
}

function member(node: jsep.MemberExpression, scope: Scope): [unknown, unknown] {
  const object = evaluate(node.object, scope) as any;
  const key = memberKey(
    node.computed ? evaluate(node.property, scope) : (node.property as jsep.Identifier).name,
  );
  return [object, object[key]];
}

/** Evaluates a parsed expression with `scope` as everything it may name. */
export function evaluate(node: Expression, scope: Scope): unknown {
  switch (node.type) {
    case "ArrayExpression":
      return (node as jsep.ArrayExpression).elements.map((element) =>
        evaluate(element, scope),
      );
    case "BinaryExpression": {
      const binary = node as jsep.BinaryExpression;
      const operator = BINARY[binary.operator];
      if (!operator) {
        throw new Error(`Unsupported operator "${binary.operator}"`);
      }
      return operator(evaluate(binary.left, scope), evaluate(binary.right, scope));
    }
    case "LogicalExpression": {
      const logical = node as jsep.LogicalExpression;
      if (logical.operator === "||") {
        return evaluate(logical.left, scope) || evaluate(logical.right, scope);
      }
      if (logical.operator === "&&") {
        return evaluate(logical.left, scope) && evaluate(logical.right, scope);
      }
      throw new Error(`Unsupported operator "${logical.operator}"`);
    }
    case "CallExpression": {
      const call = node as jsep.CallExpression;
      let self: unknown;
      let fn: unknown;
      if (call.callee.type === "MemberExpression") {
        [self, fn] = member(call.callee as jsep.MemberExpression, scope);
      } else {
        fn = evaluate(call.callee, scope);
      }
      if (typeof fn !== "function") {
        throw new TypeError("Not a function");
      }
      return fn.apply(
        self,
        call.arguments.map((argument) => evaluate(argument, scope)),
      );
    }
    case "ConditionalExpression": {
      const conditional = node as jsep.ConditionalExpression;
      return evaluate(conditional.test, scope)
        ? evaluate(conditional.consequent, scope)
        : evaluate(conditional.alternate, scope);
    }
    case "Identifier": {
      const name = (node as jsep.Identifier).name;
      return Object.prototype.hasOwnProperty.call(scope, name) ? scope[name] : undefined;
    }
    case "Literal":
      return (node as jsep.Literal).value;
    case "MemberExpression":
      return member(node as jsep.MemberExpression, scope)[1];
    case "ThisExpression":
      return scope;
    case "UnaryExpression": {
      const unary = node as jsep.UnaryExpression;
      const operator = UNARY[unary.operator];
      if (!operator) {
        throw new Error(`Unsupported operator "${unary.operator}"`);
      }
      return operator(evaluate(unary.argument, scope));
    }
    default:
      return undefined;
  }
}
