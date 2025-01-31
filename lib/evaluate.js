import { Coroutine } from '@bablr/coroutine';
import { buildGapTag, buildOpenNodeTag, buildWriteEffect } from '@bablr/agast-helpers/builders';
import { getStreamIterator, StreamIterable } from '@bablr/agast-helpers/stream';
import { formatType } from './utils/format.js';
import { facades } from './facades.js';
import { nodeStates, State } from './state.js';
import { updateSpans } from './spans.js';
import {
  OpenNodeTag,
  CloseNodeTag,
  ShiftTag,
  GapTag,
  LiteralTag,
  ReferenceTag,
  OpenFragmentTag,
  DoctypeTag,
  NullTag,
  CloseFragmentTag,
} from '@bablr/agast-helpers/symbols';
import { FragmentFacade, internalStates } from './node.js';
import {
  buildArrayInitializerTag,
  buildNullTag,
  buildStubNode,
  getOpenTag,
  sourceTextFor,
  treeFromStreamSync,
} from '@bablr/agast-helpers/tree';
import * as btree from '@bablr/agast-helpers/btree';
import { getEmbeddedTag } from '@bablr/agast-vm-helpers/deembed';
import { Match } from './match.js';
import { reifyExpression } from '@bablr/agast-vm-helpers';
import { TagPath } from '@bablr/agast-helpers/path';
import { getProduction } from '@bablr/helpers/grammar';

const bindAttribute = (m, s, key, value) => {
  const openTag = getOpenTag(m.node);

  if (value != null) {
    const { flags, language, type } = openTag.value;
    const attributes = { ...openTag.value.attributes, [key]: value };
    const newOpenTag = buildOpenNodeTag(flags, language, type, attributes);

    m.node.attributes = attributes;

    // if (openNext) {
    // } else {
    //   // could this tag be stored anywhere else?
    //   s.resultPath = newOpenTag;
    // }

    m.node.children = btree.replaceAt(0, m.node.children, newOpenTag);
  }

  nodeStates.get(m.node).unboundAttributes.delete(key);
};

const getSourceLength = (tags) => {
  let i = 0;
  for (const tag of tags) {
    if (tag.type === LiteralTag) {
      i += tag.value.length;
    } else if (tag.type === GapTag) {
      i += 1;
    }
  }
  return i;
};

export const bablr = (ctx, rootSource, strategy, options = {}) => {
  return new StreamIterable(__bablr(ctx, rootSource, strategy, options));
};

function* __bablr(ctx, rootSource, strategy, options) {
  let s = State.from(rootSource, ctx, options.expressions);
  let m = null;
  let language = null;

  let co = new Coroutine(getStreamIterator(strategy(facades.get(s), facades.get(ctx))));

  co.advance();

  {
    s.source.advance();

    const sourceStep = s.source.fork.head.step;

    if (sourceStep instanceof Promise) {
      yield sourceStep;
    }
  }

  for (;;) {
    if (co.current instanceof Promise) {
      co.current = yield co.current;
    }

    if (co.done) break;

    const instr = co.value;
    let returnValue = undefined;

    const { verb } = instr;

    switch (verb) {
      case 'init': {
        let { arguments: { 0: canonicalURL } = [] } = instr;

        if (language !== null) throw new Error();

        language = ctx.languages.get(canonicalURL);
        break;
      }

      case 'advance': {
        const { arguments: { 0: embeddedTags } = [] } = instr;

        const tag = getEmbeddedTag(embeddedTags);

        if (tag.type !== ReferenceTag) {
          s.referencePath = null;
        }

        switch (tag.type) {
          case DoctypeTag: {
            s.node = m.node;
            s.node.type = null;
            s.node.language = tag.value.attributes.bablrLanguage;
            s.advance(tag);

            m.setRangePreviousIndex(0);
            break;
          }

          case ReferenceTag: {
            s.advance(tag);

            s.referencePath = m.parent ? TagPath.from(m.parent.path, -1) : null;

            break;
          }

          case OpenFragmentTag: {
            s.advance(tag);

            break;
          }

          case OpenNodeTag: {
            s.depths.path++;

            if (s.depth === 0) {
              m.add(m.node);
            }

            s.node = m.node;

            s.advance(tag);

            updateSpans(m, s.node, 'open');

            break;
          }

          case CloseFragmentTag: {
            s.advance(tag);
            s.node = m.node;
            break;
          }

          case CloseNodeTag: {
            const { node } = s;

            const refPath = m.referencePath;

            if (refPath.tag.type === ReferenceTag && refPath?.tag.value.name === '@') {
              const cooked = node.flags.hasGap
                ? null
                : ctx.languages
                    .get(node.language)
                    .getCooked?.(
                      FragmentFacade.wrap(
                        node,
                        ctx,
                        true,
                        [refPath.childrenIndex, refPath.childrenIndex],
                        null,
                      ),
                      s.span.name,
                      facades.get(ctx),
                    ) || null;

              bindAttribute(m, s, 'cooked', cooked);

              nodeStates.get(m.node).unboundAttributes.delete('cooked');
            }

            s.advance(tag);

            s.node = m.fragmentNode;
            s.depths.path--;

            updateSpans(m, s.resultPath.path.node, 'close');

            if (s.depth > 0) {
              m.add(m.node);
            }

            if (!m.parent) {
              if (!s.source.done) {
                throw new Error('Parser failed to consume input');
              }

              if (s.balanced.size) {
                throw new Error('Parser did not match all balanced nodes');
              }
            }

            break;
          }

          case LiteralTag: {
            const { value: pattern } = tag;

            let result;
            if (
              s.resultPath.tag.type === OpenNodeTag &&
              s.resultPath.tag.value.attributes.balancer &&
              s.balanced.value.attributes.balanced === pattern
            ) {
              result = s.match(pattern);
            } else {
              result = s.guardedMatch(pattern);
            }

            if (result instanceof Promise) {
              result = yield result;
            }

            if (result) {
              let sourceStep = s.source.advance(getSourceLength(result));

              if (sourceStep instanceof Promise) {
                sourceStep = yield sourceStep;
              }

              s.advance(tag);
            } else {
              throw new Error('Failed to advance literal');
            }
            break;
          }

          case GapTag: {
            if (s.source.value == null && !s.source.done) {
              if (s.source.holding) {
                s.source.unshift();
              } else {
                const sourceStep = s.source.advance(1);

                if (sourceStep instanceof Promise) {
                  yield sourceStep;
                }
              }

              if (s.held) {
                m.add(s.held);

                s.held = null;
                break;
              }

              if (s.expressions.size) {
                const expression = s.expressions.value;

                m.add(expression);

                s.expressions = s.expressions.pop();
                break;
              }

              s.node = m.node;

              if (btree.getSum(s.node.children)) {
                s.advance(tag);
              } else {
                m.add(m.node);
                s.advance(tag);
              }

              s.node = m.fragmentNode;
            } else {
              throw new Error('Failed to advance gap');
            }
            break;
          }

          case ShiftTag: {
            // TODO make this into a shift() instruction
            s.source.shift();

            s.held = s.resultPath.node;

            const { path } = internalStates.get(s.node);
            const { properties } = s.node;

            const gapPath = TagPath.from(path, -1);

            if (!gapPath.inner) throw new Error();

            const ref = gapPath.previousSibling.tag;

            if (ref.value.isArray) {
              properties[ref.value.name] = btree.pop(properties[ref.value.name]);
            } else {
              properties[ref.value.name] = buildStubNode(buildGapTag());
            }

            s.node.children = btree.pop(s.node.children);

            break;
          }

          default:
            s.advance(tag);
        }

        if (s.depth === 0) {
          yield* m.emit();
        }

        returnValue = tag;
        break;
      }

      case 'match': {
        let { arguments: { 0: pattern } = [] } = instr;

        let result = s.guardedMatch(pattern);

        if (result instanceof Promise) {
          result = yield result;
        }

        let node = result && treeFromStreamSync(result);

        returnValue = result && FragmentFacade.wrap(node, ctx, true);
        break;
      }

      case 'openSpan': {
        let { arguments: { 0: name } = [] } = instr;
        s.spans = s.spans.push({ guard: null, name, path: s.path, type: 'Instruction' });
        break;
      }

      case 'closeSpan': {
        if (s.spans.value.type !== 'Instruction') throw new Error();
        s.spans = s.spans.pop();
        break;
      }

      case 'startFrame': {
        const {
          arguments: {
            0: { value: matcher } = {},
            1: { value: effects } = {},
            2: { value: options = {} } = {},
          } = [],
        } = instr;

        const { unboundAttributes } = options;

        const parentMatch = m;

        if (!language) throw new Error('not initialized');

        let matcher_ = reifyExpression(matcher);

        m = parentMatch
          ? parentMatch.startFrame(s, matcher_, effects)
          : Match.from(ctx, language, s, matcher_);

        if (m.isNode && m.isCover) throw new Error();

        if (!getProduction(m.grammar, m.type))
          throw new Error(`Production {type: ${m.type}} does not exist`);

        if (m.flags.token && !m.isNode) {
          throw new Error('tokens must be nodes');
        }

        if (parentMatch && parentMatch.cover && !m.isNode) {
          if (matcher_.refMatcher) {
            let m = matcher_.refMatcher;
            if (!(m.name === '.' && !m.flags.expression && !m.flags.hasGap && !m.isArray)) {
              throw new Error();
            }
          }
        }

        s = m.state;

        if (!m.isNode && options.unboundAttributes) throw new Error();

        m.fragmentNode = s.node;

        nodeStates.set(m.node, {
          unboundAttributes: m.isNode
            ? new Set(unboundAttributes)
            : new Set(parentMatch ? nodeStates.get(parentMatch.node).unboundAttributes || [] : []),
        });

        ({ language } = m);

        if (parentMatch) {
          let previousIndex = [CloseNodeTag, NullTag, GapTag].includes(s.resultPath.tag.type)
            ? btree.getSum(m.fragmentNode.children) - 1
            : s.resultPath.childrenIndex;

          m.setRangePreviousIndex(previousIndex);
        }

        returnValue = facades.get(m);
        break;
      }

      case 'endFrame': {
        const {
          arguments: { 0: hasContinuation },
        } = instr;
        const refPath = m.referencePath;
        const { mergedReference } = m;
        const finishedMatch = m;

        m = m.endFrame();

        if (m && internalStates.get(m.s.node).path.node !== m.s.node) {
          throw new Error('waaat');
        }

        if (!m) {
          returnValue = m;
          break;
        }

        s = m.state;

        const emittableRefPath =
          (!m.cover || m.isCover) &&
          refPath &&
          !hasContinuation &&
          refPath.tag.value.flags.expression
            ? s.depths.emitted === s.depths.path
              ? TagPath.from(internalStates.get(s.node).path, refPath.childrenIndex)
              : refPath
            : null;

        if (finishedMatch.state.status !== 'rejected') {
          yield* m.emit(emittableRefPath);
        }

        returnValue = facades.get(m.node);
        break;
      }

      case 'bindAttribute': {
        const { arguments: { 0: key, 1: value } = [] } = instr;

        bindAttribute(m, s, key, value);

        yield* m.emit();

        break;
      }

      case 'throw': {
        s.reject();

        let rejectedMatch = m;

        m = m.endFrame();
        s = m.state;

        let ref = null;

        if (rejectedMatch.isNode) {
          ref = rejectedMatch.mergedReference;
        }

        if (ref && ref.value.name !== '#') {
          s.advance(ref);

          if (ref.value.isArray) {
            s.advance(buildArrayInitializerTag());
          } else {
            s.advance(buildNullTag());
          }
        }

        if (!m) {
          returnValue = m;
          break;
        }

        returnValue = facades.get(m);
        break;
      }

      case 'write': {
        const { arguments: { 0: text, 1: { value: writeOptions } = {} } = [] } = instr;

        if (options.emitEffects) {
          yield buildWriteEffect(text, writeOptions);
        }
        break;
      }

      case 'getState': {
        returnValue = facades.get(s);
        break;
      }

      default: {
        throw new Error(`Unexpected call of {type: ${formatType(verb)}}`);
      }
    }

    co.advance(returnValue);
  }

  return s.node;
}
