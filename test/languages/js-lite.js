import { str, map, compose } from 'iter-tools-es';

import {
  Grammar,
  eat,
  match,
  eatMatch,
  startNode,
  endNode,
  startToken,
  endToken,
} from '@cst-tokens/helpers/grammar';
import { objectEntries } from '@cst-tokens/helpers/object';
import { ref, tok, chrs } from '@cst-tokens/helpers/shorthand';
import { LexicalBoundary, EOF } from '@cst-tokens/helpers/symbols';
import * as sym from '@cst-tokens/helpers/symbols';

export const _ = 'Separator';
export const PN = (value) => ({ type: sym.terminal, value: { type: 'Punctuator', value } });
export const LPN = (value) => ({ type: sym.terminal, value: { type: 'LeftPunctuator', value } });
export const RPN = (value) => ({ type: sym.terminal, value: { type: 'RightPunctuator', value } });
export const KW = (value) => ({ type: sym.terminal, value: { type: 'Keyword', value } });

const escapables = new Map(
  objectEntries({
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    0: '\0',
  }),
);

export const WithToken = ([key, production]) => {
  const name = `WithToken_${production.name}`;
  return [
    key,
    {
      *[name](props, grammar) {
        if (grammar.is('Token', key)) {
          yield startToken(key);
          yield* production(props);
          yield endToken();
        } else {
          yield* production(props);
        }
      },
    }[name],
  ];
};

const bareTransitions = new Map(
  objectEntries({
    "'": ["'", 'String:Single', "'"],
    '"': ['"', 'String:Double', '"'],
    '/*': ['/*', 'Comment:Block', '*/'],
    '//': ['//', 'Comment:Line', '\n'],
    '/': ['/', 'Regex', '/'],
  }),
);

export const tokenGrammar = new Grammar({
  aliases: objectEntries({
    Token: [
      'Whitespace',
      'Keyword',
      'Punctuator',
      'LeftPunctuator',
      'RightPunctuator',
      'Literal',
      'StringStart',
      'StringEnd',
      'Escape',
      'EscapeCode',
    ],
    Comment: ['BlockComment', 'LineComment'],
    Trivia: ['Comment', 'Whitespace'],
    [LexicalBoundary]: ['CommentStart', 'CommentEnd', 'StringStart', 'StringEnd'],
  }),
  context: {
    *transition(lexicalContext, boundaryToken) {
      if (lexicalContext === 'Bare') {
        yield* bareTransitions.get(boundaryToken);
      } else {
        throw new Error();
      }
    },
  },
  productions: map(
    WithToken,
    objectEntries({
      *Separator() {
        // StartNode and EndNode?
        yield eat('Trivia');
        while (yield eatMatch('Trivia'));
      },

      *BlockComment() {
        yield eatMatch(ref({ type: 'CommentStart', value: '/*' }));

        yield eatMatch('Literal');

        yield eatMatch(ref({ type: 'CommentEnd', value: '*/' }));
      },

      *LineComment() {
        yield eatMatch(ref({ type: 'CommentStart', value: '//' }));

        yield eatMatch('Literal');

        if (yield match(ref({ type: EOF }))) return;

        yield eatMatch(ref({ type: 'CommentEnd', value: '\n' }));
      },

      *Whitespace() {
        yield eat(/\w+/y);
      },

      *Keyword({ value, lexicalContext }) {
        if (lexicalContext !== 'Bare') {
          throw new Error(`{lexicalContext: ${lexicalContext}} does not allow keywords`);
        }
        yield eat(chrs(value));
      },

      *Identifier() {
        (yield eatMatch('Escape', 'EscapeCode')) || (yield eatMatch('Literal' /* isFirst: true */));

        while ((yield eatMatch('Escape', 'EscapeCode')) || (yield eatMatch('Literal')));
      },

      *Punctuator({ value }) {
        yield eat(chrs(value));
      },

      *LeftPunctuator({ value }) {
        yield eat(chrs(value));
      },

      *RightPunctuator({ value }) {
        yield eat(chrs(value));
      },

      *Literal({ lexicalContext, isFirst = false }) {
        if (lexicalContext === 'String:Single') {
          yield eat(/[^\\']+/y);
        } else if (lexicalContext === 'String:Double') {
          yield eat(/[^\\"]+/y);
        } else if (lexicalContext === 'Bare') {
          // it may be appropriate for the literal to contain only a digit, e.g. foo\u{42}9
          if (isFirst) {
            yield eat(/[$_\w][$_\w\d]*/y);
          } else {
            yield eat(/[$_\w\d]+/y);
          }
        } else {
          throw new Error(`{lexicalContext: ${lexicalContext}} does not allow literals`);
        }
      },

      *String() {
        let q; // quotation mark
        q = yield eatMatch(ref({ type: 'StringStart', value: `'` }));
        q = q || (yield eat(ref({ type: 'StringStart', value: `"` })));

        while ((yield eatMatch('Escape', 'EscapeCode')) || (yield eatMatch('Literal')));

        yield eat(ref({ type: 'StringEnd', value: q }));
      },

      *Escape({ lexicalContext }) {
        if (lexicalContext.startsWith('String')) {
          yield eat(chrs('\\'));
        } else {
          throw new Error(`{lexicalContext: ${lexicalContext}} does not define any escapes`);
        }
      },

      *EscapeCode({ lexicalContext }) {
        if (lexicalContext.startsWith('String')) {
          if (yield eatMatch(/u{\d{1,6}}/y)) {
            // break
          } else if (yield eatMatch(/u\d\d\d\d/y)) {
            // break
          } else if (yield eatMatch(/x\d\d/y)) {
            // break
          } else if (yield eatMatch(chrs(str(escapables.keys())))) {
            // break
          }
        } else {
          throw new Error(`{lexicalContext: ${lexicalContext}} does not define any escape codes`);
        }
      },
    }),
  ),
});

const spaceDelimitedTypes = ['Identifier', 'Keyword'];

export const WithWhitespace = ([key, production]) => {
  const name = `WithWhitespace_${production.name}`;

  return [
    key,
    {
      *[name](props) {
        const { getState } = props;

        const generator = production(props);
        let current = generator.next();
        let state;

        while (!current.done) {
          const cmd = current.value;
          const cause = cmd.error;
          let returnValue;

          cmd.error = cause && new Error(undefined, { cause });

          state = getState();

          switch (cmd.type) {
            case sym.eat:
            case sym.match:
            case sym.eatMatch: {
              const { type } = cmd.value;

              const spaceIsAllowed = state.lexicalContext === 'Base';

              if (spaceIsAllowed) {
                const spaceIsNecessary =
                  !!lastType &&
                  spaceDelimitedTypes.includes(lastType) &&
                  spaceDelimitedTypes.includes(type);

                if (spaceIsNecessary) {
                  yield eat('Separator');
                } else {
                  yield eatMatch('Separator');
                }
              }

              returnValue = yield cmd;
              break;
            }

            default:
              returnValue = yield cmd;
              break;
          }

          current = generator.next(returnValue);
        }
      },
    }[name],
  ];
};

export const WithNode = ([type, production]) => {
  const name = `WithNode_${production.name}`;
  return [
    type,
    {
      *[name](props, grammar) {
        if (grammar.is('Node', type)) {
          yield startNode();
          yield* production(props);
          yield endNode();
        } else {
          yield* production(props);
        }
      },
    }[name],
  ];
};

const formatType = (type) => {
  return typeof type === 'symbol' ? `[${type.description.replace(/^cst-tokens\//, '')}]` : type;
};

export const WithLogging = ([type, production]) => {
  const name = `WithLogging_${production.name}`;
  return [
    type,
    {
      *[name](props) {
        console.log(`--> ${formatType(type)}`);

        for (const instr of production(props)) {
          const formattedVerb = instr.type ? ` ${formatType(instr.type)}` : '<unknown>';
          const edible = instr.value;
          const formattedMode = edible ? ` ${formatType(edible.type)}` : '';
          const descriptor = edible?.value;
          const formattedDescriptor = descriptor ? ` ${formatType(descriptor.type)}` : '';
          console.log(`instr ${formatType(formattedVerb)}${formattedMode}${formattedDescriptor}`);
          yield instr;
        }

        console.log(`<-- ${formatType(type)}`);
      },
    }[name],
  ];
};

export const syntaxGrammar = new Grammar({
  aliases: objectEntries({
    Literal: ['StringLiteral'],
    ImportSpecialSpecifier: ['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'],
    Node: [
      'Program',
      'ImportDeclaration',
      'ImportSpecifier',
      'ImportDefaultSpecifier',
      'ImportNamespaceSpecifier',
      'String',
      'Identifier',
    ],
  }),

  productions: map(
    compose(WithNode, /*WithWhitespace*/ WithLogging),
    objectEntries({
      *Program() {
        while (yield eatMatch(ref`body:ImportDeclaration`));
      },

      *ImportDeclaration() {
        yield eat(KW`import`);

        yield { type: 'debug' };
        const special = yield eatMatch(ref`specifiers:ImportSpecialSpecifier`);

        const brace = special ? yield eatMatch(PN`,`, LPN`{`) : yield eatMatch(LPN`{`);
        if (brace) {
          for (;;) {
            yield eat(ref`specifier:ImportSpecifier`);

            if (yield match(RPN`}`)) break;
            if (yield match(PN`,`, RPN`}`)) break;
            yield eat(PN`,`);
          }
          yield eatMatch(PN`,`);
          yield eat(RPN`}`);
          yield eat(KW`from`);
        }

        yield eat(ref`source:StringLiteral`);
        yield eatMatch(PN`;`);
      },

      *ImportSpecifier() {
        // Ref captured inside match is used only in the shorthand case
        yield match(ref`local:Identifier`);
        yield eat(ref`imported:Identifier`);
        yield eatMatch(KW`as`, ref`local:Identifier`);
      },

      *ImportDefaultSpecifier() {
        yield eat(ref`local:Identifier`);
      },

      *ImportNamespaceSpecifier() {
        yield eat(PN`*`, KW`as`, ref`local:Identifier`);
      },

      *String() {
        yield eat(tok`String`);
      },

      *Identifier() {
        yield eat(tok`Identifier`);
      },
    }),
  ),
});

export default {
  grammars: {
    token: tokenGrammar,
    syntax: syntaxGrammar,
  },
};
