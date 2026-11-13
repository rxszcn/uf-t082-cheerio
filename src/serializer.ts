import renderWithDomSerializer from 'dom-serializer';
import {
  type AnyNode,
  type Element,
  hasChildren,
  isDirective,
  isDocument,
  type ProcessingInstruction,
} from 'domhandler';
import type { InternalOptions } from './options.js';

/**
 * Render a DOM tree to markup.
 *
 * In HTML mode this delegates to `dom-serializer`, so the output is unchanged.
 *
 * In XML mode, processing instructions and XML declarations are rendered here:
 * `dom-serializer` closes them with a single `>` (e.g. `<?xml version="1.0">`),
 * which is not valid XML. A standard XML parser keeps looking for the closing
 * `?>` and swallows the rest of the document into the instruction, so the
 * whole tree disappears. Subtrees that contain no such directive are still
 * handed to `dom-serializer` as a whole, keeping their output identical.
 *
 * @param dom - The DOM tree to render.
 * @param options - Options for rendering.
 * @returns The rendered markup.
 */
export function renderDom(
  dom: AnyNode | ArrayLike<AnyNode>,
  options: InternalOptions,
): string {
  if (options.xmlMode !== true) {
    return renderWithDomSerializer(dom, options);
  }

  const nodes: ArrayLike<AnyNode> = 'length' in dom ? dom : [dom];
  const parents = collectDirectiveParents(nodes);
  let output = '';

  for (let index = 0; index < nodes.length; index++) {
    output += renderXmlNode(nodes[index], options, parents);
  }

  return output;
}

/**
 * Render a single node in XML mode.
 *
 * @param node - The node to render.
 * @param options - Options for rendering.
 * @param parents - Nodes whose subtree contains a directive.
 * @returns The rendered node.
 */
function renderXmlNode(
  node: AnyNode,
  options: InternalOptions,
  parents: ReadonlySet<AnyNode>,
): string {
  if (isDirective(node)) {
    return renderDirective(node);
  }

  if (parents.has(node)) {
    return isDocument(node)
      ? renderXmlChildren(node.children, options, parents)
      : renderXmlElement(node as Element, options, parents);
  }

  return renderWithDomSerializer(node, options);
}

/**
 * Render the children of a node in XML mode.
 *
 * @param children - The child nodes to render.
 * @param options - Options for rendering.
 * @param parents - Nodes whose subtree contains a directive.
 * @returns The rendered children.
 */
function renderXmlChildren(
  children: ArrayLike<AnyNode>,
  options: InternalOptions,
  parents: ReadonlySet<AnyNode>,
): string {
  let output = '';

  for (let index = 0; index < children.length; index++) {
    output += renderXmlNode(children[index], options, parents);
  }

  return output;
}

/**
 * Render an element in XML mode, leaving attributes and children to the DOM
 * serializer.
 *
 * Only elements that contain a directive end up here. Those always have
 * children, so they are never rendered as self-closing tags.
 *
 * @param element - The element to render.
 * @param options - Options for rendering.
 * @param parents - Nodes whose subtree contains a directive.
 * @returns The rendered element.
 */
function renderXmlElement(
  element: Element,
  options: InternalOptions,
  parents: ReadonlySet<AnyNode>,
): string {
  /*
   * Render a childless copy to reuse the serializer's tag and attribute
   * formatting. `selfClosingTags` is forced on so the result always ends with
   * `/>`, which is then replaced by `>` plus the separately rendered children.
   */
  const selfClosing = renderWithDomSerializer(element.cloneNode(false), {
    ...options,
    selfClosingTags: true,
  });

  return `${selfClosing.slice(0, -2)}>${renderXmlChildren(
    element.children,
    options,
    parents,
  )}</${element.name}>`;
}

/**
 * Render a processing instruction or an XML declaration.
 *
 * `htmlparser2` stores instruction data with a leading `?` but without the
 * closing `?` (it ends the instruction at the preceding `?`), so appending
 * `?>` restores the standard form. Other directives, such as a doctype
 * (`<!DOCTYPE html>`), already have their standard framing.
 *
 * @param node - The directive to render.
 * @returns The rendered directive.
 */
function renderDirective(node: ProcessingInstruction): string {
  return node.data.startsWith('?') ? `<${node.data}?>` : `<${node.data}>`;
}

/**
 * Collect every node whose subtree contains a processing instruction or an
 * XML declaration, in a single pass over the tree.
 *
 * @param nodes - The nodes to inspect.
 * @returns The nodes that need the directive-aware renderer.
 */
function collectDirectiveParents(
  nodes: ArrayLike<AnyNode>,
): ReadonlySet<AnyNode> {
  const parents = new Set<AnyNode>();

  for (let index = 0; index < nodes.length; index++) {
    markDirectiveParents(nodes[index], parents);
  }

  return parents;
}

/**
 * Walk a subtree, recording every node along the path to a processing
 * instruction or XML declaration.
 *
 * @param node - The node to inspect.
 * @param parents - The set that matching nodes are added to.
 * @returns Whether the node's subtree contains such a directive.
 */
function markDirectiveParents(node: AnyNode, parents: Set<AnyNode>): boolean {
  if (isDirective(node)) {
    /*
     * Doctypes start with `!`, processing instructions and XML declarations
     * start with `?`.
     */
    return node.data.startsWith('?');
  }

  if (!hasChildren(node)) {
    return false;
  }

  let found = false;

  for (let index = 0; index < node.children.length; index++) {
    // Keep iterating so nested directives are visited too.
    if (markDirectiveParents(node.children[index], parents)) {
      found = true;
    }
  }

  if (found) {
    parents.add(node);
  }

  return found;
}
