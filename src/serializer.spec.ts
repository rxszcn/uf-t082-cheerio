import renderWithDomSerializer from 'dom-serializer';
import {
  type AnyNode,
  isDirective,
  isDocument,
  isTag,
  isText,
  type ProcessingInstruction,
} from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { load } from './load-parse.js';
import type { InternalOptions } from './options.js';
import { renderDom } from './serializer.js';

const xmlOptions: InternalOptions = { _useHtmlParser2: true, xmlMode: true };
const htmlOptions: InternalOptions = { _useHtmlParser2: true };

/** A parser-independent view of a node tree. */
type CanonicalNode =
  | {
      type: 'element';
      name: string;
      attributes: [string, string][];
      children: CanonicalNode[];
    }
  | { type: 'text'; data: string }
  | { type: 'processing-instruction'; target: string; data: string };

/** Minimal shape of the nodes produced by a standard DOM implementation. */
interface StandardNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<StandardNode>;
  attributes?: ArrayLike<{ name: string; value: string }>;
}

/**
 * Parse a string as XML with a standard, third-party XML parser.
 *
 * @param content - The markup to parse.
 * @returns The parsed document.
 */
function parseWithStandardParser(content: string): StandardNode {
  const { window } = new JSDOM('');

  return new window.DOMParser().parseFromString(content, 'text/xml');
}

/**
 * Canonicalize the children of a standard-DOM node, skipping the root node.
 *
 * XML declarations are dropped, as standard DOM parsers don't represent them.
 *
 * @param node - The node whose children should be canonicalized.
 * @returns The canonical child nodes.
 */
function canonicalizeStandardChildren(node: StandardNode): CanonicalNode[] {
  const result: CanonicalNode[] = [];

  for (let index = 0; index < node.childNodes.length; index++) {
    const child = node.childNodes[index];
    result.push(...canonicalizeStandardNode(child));
  }

  return result;
}

/**
 * Canonicalize a single standard-DOM node.
 *
 * @param node - The node to canonicalize.
 * @returns The canonical node, or an empty array if it has no equivalent.
 */
function canonicalizeStandardNode(node: StandardNode): CanonicalNode[] {
  // Element
  if (node.nodeType === 1) {
    const attributes: [string, string][] = [];
    const sourceAttributes = node.attributes ?? [];

    for (let index = 0; index < sourceAttributes.length; index++) {
      const attribute = sourceAttributes[index];
      attributes.push([attribute.name, attribute.value]);
    }

    return [
      {
        type: 'element',
        name: node.nodeName,
        attributes,
        children: canonicalizeStandardChildren(node),
      },
    ];
  }

  // Text
  if (node.nodeType === 3) {
    return [{ type: 'text', data: node.nodeValue ?? '' }];
  }

  // Processing instruction (node type 7)
  if (node.nodeType === 7) {
    return [
      {
        type: 'processing-instruction',
        target: node.nodeName,
        data: node.nodeValue ?? '',
      },
    ];
  }

  return [];
}

/**
 * Canonicalize a Cheerio (domhandler) node list into the same shape.
 *
 * @param nodes - The nodes to canonicalize.
 * @returns The canonical nodes.
 */
function canonicalizeCheerioNodes(nodes: ArrayLike<AnyNode>): CanonicalNode[] {
  const result: CanonicalNode[] = [];

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    result.push(...canonicalizeCheerioNode(node));
  }

  return result;
}

/**
 * Canonicalize a single Cheerio (domhandler) node.
 *
 * @param node - The node to canonicalize.
 * @returns The canonical node, or an empty array if it has no equivalent.
 */
function canonicalizeCheerioNode(node: AnyNode): CanonicalNode[] {
  if (isDocument(node)) {
    return canonicalizeCheerioNodes(node.children);
  }

  if (isTag(node)) {
    return [
      {
        type: 'element',
        name: node.name,
        attributes: Object.entries(node.attribs),
        children: canonicalizeCheerioNodes(node.children),
      },
    ];
  }

  if (isDirective(node)) {
    return canonicalizeDirective(node);
  }

  if (isText(node)) {
    return [{ type: 'text', data: node.data }];
  }

  return [];
}

/**
 * Drop the leading `?` that `htmlparser2` adds to instruction names and data.
 *
 * @param value - The name or data to normalize.
 * @returns The value without the leading `?`.
 */
function stripInstructionPrefix(value: string): string {
  return value.startsWith('?') ? value.slice(1) : value;
}

/**
 * Canonicalize a directive node.
 *
 * @param node - The directive to canonicalize.
 * @returns The canonical node, or an empty array for doctypes and XML
 *   declarations, which standard DOM parsers don't expose.
 */
function canonicalizeDirective(node: ProcessingInstruction): CanonicalNode[] {
  if (node.name.startsWith('!') || node.name.startsWith('?xml')) {
    return [];
  }

  return [
    {
      type: 'processing-instruction',
      target: stripInstructionPrefix(node.name),
      data: stripInstructionPrefix(node.data),
    },
  ];
}

/**
 * Load the given XML and return the canonical tree it describes.
 *
 * @param content - The XML markup.
 * @returns The canonical tree.
 */
function cheerioTree(content: string): CanonicalNode[] {
  return canonicalizeCheerioNodes(load(content, { xml: true }).root());
}

/**
 * Check whether a standard-DOM document was rejected by its parser.
 *
 * @param document - The parsed document.
 * @returns Whether the parser reported an error.
 */
function hasParseError(document: StandardNode): boolean {
  for (let index = 0; index < document.childNodes.length; index++) {
    if (document.childNodes[index].nodeName === 'parsererror') {
      return true;
    }
  }

  return false;
}

const roundTripCases = [
  '<?xml version="1.0" encoding="UTF-8"?><root><a/><b>text</b></root>',
  '<?xml version="1.0"?><rss version="2.0"><channel><item><title>x</title></item></channel></rss>',
  '<?xml-stylesheet type="text/xsl" href="style.xsl"?><root><?target some data?><child/></root>',
  '<root><?pi?><a>x</a><?pi2 data here?></root>',
  '<root><?nested deep?><outer><inner><?pi x?></inner></outer></root>',
  '<root><?pi after?><a>é &amp; &lt;</a></root>',
];

describe('serializer', () => {
  describe('processing instructions', () => {
    it('should close processing instructions with `?>`', () => {
      const $ = load('<?xml version="1.0"?><root><?foo bar?></root>', {
        xml: true,
      });

      expect($.xml()).toBe('<?xml version="1.0"?><root><?foo bar?></root>');
    });

    it('should close XML declarations with `?>`', () => {
      const $ = load('<?xml-stylesheet href="a.xsl"?><root/>', { xml: true });

      expect($.xml()).toBe('<?xml-stylesheet href="a.xsl"?><root/>');
    });

    it('should keep the `?` that is part of the instruction data', () => {
      const $ = load('<root><?foo a??></root>', { xml: true });

      expect($.xml()).toBe('<root><?foo a??></root>');
    });

    it('should leave directives with standard framing untouched', () => {
      const input = '<!DOCTYPE root><root><c/></root>';
      const $ = load(input, { xml: true });

      expect($.xml()).toBe(input);
    });
  });

  describe('XML round trips', () => {
    for (const input of roundTripCases) {
      it(`should be restored by a standard XML parser: ${input}`, () => {
        const rendered = load(input, { xml: true }).xml();

        const reparsed = parseWithStandardParser(rendered);
        expect(reparsed.nodeType).toBe(9);
        expect(hasParseError(reparsed)).toBe(false);
        expect(canonicalizeStandardChildren(reparsed)).toEqual(
          canonicalizeStandardChildren(parseWithStandardParser(input)),
        );

        expect(cheerioTree(rendered)).toEqual(cheerioTree(input));

        // Re-serializing the output must not change it.
        expect(load(rendered, { xml: true }).xml()).toBe(rendered);
      });
    }

    it('should render declarations that precede a doctype without loss', () => {
      const input =
        '<?xml version="1.0"?><?xml-model href="m"?><root><a/></root>';
      const produced = load(input, { xml: true }).xml();

      expect(produced).toBe(input);
      expect(
        canonicalizeStandardChildren(parseWithStandardParser(produced)),
      ).toEqual(canonicalizeStandardChildren(parseWithStandardParser(input)));
    });
  });

  describe('non-regression', () => {
    it('should render XML without directives exactly as `dom-serializer` does', () => {
      const input = '<root a="1"><child b=""><nested>t</nested></child></root>';
      const dom = parseDocument(input, { xmlMode: true });

      expect(renderDom(dom, xmlOptions)).toBe(
        renderWithDomSerializer(dom, { xmlMode: true }),
      );
    });

    it('should not change HTML output', () => {
      const inputs = [
        '<div class="a"><p>text</p><br></div>',
        '<ul><li>one<li>two</ul>',
        '<script>if (a < b) {}</script>',
        '<div data-x="&amp;">&lt;text&gt;</div>',
        '<svg><path d="M0 0"/></svg>',
        '<!doctype html><html><head></head><body><p>hi</p></body></html>',
        '<r><?pi x?></r>',
      ];

      for (const input of inputs) {
        const dom = parseDocument(input);
        expect(renderDom(dom, htmlOptions)).toBe(
          renderWithDomSerializer(dom, htmlOptions),
        );
      }
    });
  });
});
