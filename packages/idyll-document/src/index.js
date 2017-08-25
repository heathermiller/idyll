const React = require('react');
const walkVars = require('./visitors/vars');
const walkNode = require('./visitors/node');
const ReactJsonSchema = require('./utils/schema2element').default;
const {
  flattenObject,
  getData,
  getNodesByName,
  getVars,
  splitAST,
  translate,
  findWrapTargets,
  mapTree,
  evalExpression,
} = require('./utils');

const transformRefs = (refs) => {
  const output = {};
  const keys = ['scrollProgress', 'size', 'position'];
  Object.keys(refs).forEach((ref) => {
    const val = refs[ref];
    keys.forEach((key) => {
      if (val === null || val === undefined) {
        return;
      }
      const results = flattenObject(key, val[key]);
      Object.keys(results).forEach((result) => {
        output['_idyllRefs' + ref + result] = results[result];
      });
    });
  });
  return output;
};

const triggers = [];

class Wrapper extends React.PureComponent {
  constructor() {
    super();
    // add listener that will be called with new doc state
    // when any component calls updateProps()
    triggers.push((newState) => {
      // update this component's state
      const nextState = {};
      // pull in the latest value for any tracked vars
      Object.keys(this.props.__vars__).forEach(key => {
        nextState[key] = newState[this.props.__vars__[key]];
      });
      // re-run this component's expressions using the latest doc state
      Object.keys(this.props.__expr__).forEach(key => {
        nextState[key] = evalExpression(newState, this.props.__expr__[key]);
      });
      // trigger a re-render of this component
      // and more importantly, its wrapped component
      this.setState(nextState);
    })
  }

  render() {
    return (
      <span style={{backgroundColor: 'deepskyblue'}}>
        {
          React.Children.map(this.props.children, c => {
            return React.cloneElement(c, {...this.state})
          })
        }
      </span>
    )
  }
}

const getDerivedValues = dVars => {
  const o = {}
  Object.keys(dVars).forEach(key => o[key] = dVars[key].value)
  return o
}

class IdyllDocument extends React.PureComponent {
  constructor(props) {
    super(props);

    // Walk the tree, creating the proper components for evererything.
    this.bindings = {};
    this._idyllRefs = {};
    this.updateFuncCache = {};

    const {
      vars,
      derived,
      data,
      elements,
    } = splitAST(props.ast);

    const initialState = {
      ...getVars(vars),
      ...getData(data, props.datasets)
    };
    const derivedVars = this.derivedVars = getVars(derived, initialState);

    let state = this.state = {
      ...initialState,
      ...getDerivedValues(derivedVars)
    };

    // still sets up bindings and refs
    props.ast.map(walkVars(this, props.datasets));

    const rjs = new ReactJsonSchema();
    rjs.setComponentMap({...props.componentClasses, Wrapper});
    const schema = translate(props.ast);

    const wrapTargets = findWrapTargets(schema, this.state);

    const transformedSchema = mapTree(
      schema,
      node => {
        if (!wrapTargets.includes(node) || typeof node === 'string') return node;

        const {
          component,
          children,
          key,
          __vars__ = {},
          __expr__ = {},
          ...props // actual component props
        } = node;

        // assign the initial values for tracked vars and expressions
        Object.keys(props).forEach(k => {
          if (__vars__[k]) {
            node[k] = state[__vars__[k]];
          }
          if (__expr__[k]) {
            node[k] = evalExpression(state, __expr__[k]);
          }
        });

        // define the function wrapped components will call via this.props.updateProps
        node.updateProps = (newProps) => {
          // init new doc state object
          const newState = {};
          // iterate over passed in updates
          Object.keys(newProps).forEach(k => {
            // if a tracked var was updated get its new value
            if (__vars__[k]) {
              newState[__vars__[k]] = newProps[k]
            }
          })
          // merge new doc state with old
          const newMergedState = {...state, ...newState};
          // update derived values
          const newDerivedValues = getDerivedValues(
            getVars(derived, newMergedState)
          )

          // update doc state reference
          state = {...newMergedState, ...newDerivedValues}

          // pass the new doc state to all listeners aka component wrappers
          triggers.forEach(f => f(state))
        }

        return {
          component: Wrapper,
          __vars__,
          __expr__,
          children: [
            node
          ]
        }
      },
    );

    this.kids = rjs.parseSchema({
      component: 'div',
      className: 'idyll-root',
      children: transformedSchema
    });
  }

  updateDerivedVars(newState) {
    Object.keys(this.derivedVars).forEach((dv) => {
      this.derivedVars[dv].value = this.derivedVars[dv].update(newState, this.state);
    });
  }

  getDerivedVars() {
    let dvs = {};
    Object.keys(this.derivedVars).forEach((dv) => {
      dvs[dv] = this.derivedVars[dv].value;
    });
    return dvs;
  }

  componentDidMount() {
    const refKeys = Object.keys(this._idyllRefs);
    if (!refKeys.length) {
      return;
    }
    refKeys.forEach((name) => {
      const ref = this._idyllRefs[name];
      const rect = ref.domNode().getBoundingClientRect();
      this._idyllRefs[name]._node = ref.domNode();
      this._idyllRefs[name].size = {
        x: rect.width,
        y: rect.height
      };

      this._idyllRefs[name].position = {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom:  rect.bottom
      };

      this._idyllRefs[name].absolutePosition = {
        top: rect.top + window.scrollY,
        left: rect.left + window.scrollX,
        right: rect.right + window.scrollX,
        bottom:  rect.bottom + window.scrollY
      };

    });
    this.setState(transformRefs(this._idyllRefs));

    window.addEventListener('scroll', (e) => {
      // calculate current position based on scroll position
      const body = document.body;
      const html = document.documentElement;
      const documentWidth = Math.max(body.scrollWidth, body.offsetWidth, html.clientWidth, html.scrollWidth, html.offsetWidth );
      const documentHeight = Math.max(body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight, html.offsetHeight );
      const windowWidth = window.innerWidth || document.documentElement.clientWidth || document.body.clientWidth;
      const windowHeight = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight;
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;

      const newRefs = {};
      Object.keys(this._idyllRefs).forEach((ref) => {
        const { size, absolutePosition, _node } = this._idyllRefs[ref];

        // 0 percent === top of the div is over the bottom of the window
        const minY = Math.max(0, absolutePosition.top - windowHeight);
        // 100 percent === bottom of div is at top of window
        const maxY = Math.min(documentHeight - windowHeight, absolutePosition.bottom);

        const minX = Math.max(0, absolutePosition.left - windowWidth);
        const maxX = Math.min(documentWidth - windowWidth, absolutePosition.right);

        const rect = _node.getBoundingClientRect();
        newRefs[ref] = {
          scrollProgress: {
            x: minX === maxX ? 1 : Math.max(0, Math.min(1, (scrollX - minX) / (maxX - minX))),
            y: minY === maxY ? 1 : Math.max(0, Math.min(1, (scrollY - minY) / (maxY - minY)))
          },
          position: {
            top: rect.top,
            left: rect.left,
            right: rect.right,
            bottom:  rect.bottom
          }
        };
        this._idyllRefs[ref] = Object.assign({}, this._idyllRefs[ref], newRefs[ref]);
      });

      this.setState(transformRefs(newRefs));
    });
  }

  render() {
    return this.kids;
  }
}

module.exports = IdyllDocument;
