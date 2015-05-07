"format register";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function dedupe(deps) {
    var newDeps = [];
    for (var i = 0, l = deps.length; i < l; i++)
      if (indexOf.call(newDeps, deps[i]) == -1)
        newDeps.push(deps[i])
    return newDeps;
  }

  function register(name, deps, declare, execute) {
    if (typeof name != 'string')
      throw "System.register provided no module name";
    
    var entry;

    // dynamic
    if (typeof declare == 'boolean') {
      entry = {
        declarative: false,
        deps: deps,
        execute: execute,
        executingRequire: declare
      };
    }
    else {
      // ES6 declarative
      entry = {
        declarative: true,
        deps: deps,
        declare: declare
      };
    }

    entry.name = name;
    
    // we never overwrite an existing define
    if (!defined[name])
      defined[name] = entry; 

    entry.deps = dedupe(entry.deps);

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }

  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      
      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;
      
      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {
        
        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;
      exports[name] = value;

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          var importerIndex = indexOf.call(importerModule.dependencies, module);
          importerModule.setters[importerIndex](exports);
        }
      }

      module.locked = false;
      return value;
    });
    
    module.setters = declaration.setters;
    module.execute = declaration.execute;

    if (!module.setters || !module.execute)
      throw new TypeError("Invalid System.register form for " + entry.name);

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = { 'default': depEntry.module.exports, __useDefault: true };
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);
    
      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);
    
    if (output)
      module.exports = output;
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    var module = entry.declarative ? entry.module.exports : { 'default': entry.module.exports, '__useDefault': true };

    // return the defined module object
    return modules[name] = module;
  };

  return function(main, declare) {

    var System;

    // if there's a system loader, define onto it
    if (typeof System != 'undefined' && System.register) {
      declare(System);
      System['import'](main);
    }
    // otherwise, self execute
    else {
      declare(System = {
        register: register, 
        get: load, 
        set: function(name, module) {
          modules[name] = module; 
        },
        newModule: function(module) {
          return module;
        },
        global: global 
      });
      System.set('@empty', System.newModule({}));
      load(main);
    }
  };

})(typeof window != 'undefined' ? window : global)
/* ('mainModule', function(System) {
  System.register(...);
}); */

('d2', function(System) {

System.register("d2/lib/utils", [], function (_export) {
    _export("throwError", throwError);

    _export("curry", curry);

    _export("addLockedProperty", addLockedProperty);

    _export("copyOwnProperties", copyOwnProperties);

    _export("pick", pick);

    function throwError(message) {
        throw new Error(message);
    }

    function curry(toCurry, parameter) {
        if (typeof toCurry === "function") {
            return function () {
                var args = Array.prototype.slice.call(arguments, 0);

                return toCurry.apply(this, [parameter].concat(args));
            };
        }
    }

    function addLockedProperty(object, name, value) {
        var propertyDescriptor = {
            enumerable: true,
            configurable: false,
            writable: false,
            value: value
        };
        Object.defineProperty(object, name, propertyDescriptor);
    }

    function copyOwnProperties(to, from) {
        var key;

        for (key in from) {
            if (from.hasOwnProperty(key)) {
                to[key] = from[key];
            }
        }

        return to;
    }

    function pick(property) {
        return function (item) {
            if (item) {
                return item[property];
            }
            return undefined;
        };
    }

    return {
        setters: [],
        execute: function () {
            "use strict";
        }
    };
});
System.register("d2/lib/check", [], function (_export) {

    //TODO: Decide if checkType([], 'object') is a 'false' positive

    _export("checkType", checkType);

    _export("checkDefined", checkDefined);

    _export("isType", isType);

    _export("isString", isString);

    _export("isArray", isArray);

    _export("isObject", isObject);

    _export("isDefined", isDefined);

    _export("isInteger", isInteger);

    _export("isNumeric", isNumeric);

    _export("contains", contains);

    _export("isValidUid", isValidUid);

    function checkType(value, type, name) {
        checkDefined(value, name);
        checkDefined(type, "Type");

        if (typeof type === "function" && value instanceof type || typeof type === "string" && typeof value === type) {
            return true;
        }
        throw new Error(["Expected", name || value, "to have type", type].join(" "));
    }

    function checkDefined(value, name) {
        if (value !== undefined) {
            return true;
        }
        throw new Error([name || "Value", "should be provided"].join(" "));
    }

    function isType(value, type) {
        try {
            checkType(value, type);
            return true;
        } catch (e) {}

        return false;
    }

    function isString(value) {
        return isType(value, "string");
    }

    function isArray(value) {
        return Array.isArray(value);
    }

    function isObject(value) {
        return isType(value, Object);
    }

    function isDefined(value) {
        return value !== undefined;
    }

    function isInteger(nVal) {
        return typeof nVal === "number" && isFinite(nVal) && nVal > -9007199254740992 && nVal < 9007199254740992 && Math.floor(nVal) === nVal;
    }

    function isNumeric(nVal) {
        return typeof nVal === "number" && isFinite(nVal) && nVal - parseFloat(nVal) + 1 >= 0;
    }

    function contains(item, list) {
        list = isArray(list) && list || [];

        return list.indexOf(item) >= 0;
    }

    function isValidUid(value) {
        return value && value.length === 11;
    }

    return {
        setters: [],
        execute: function () {
            "use strict";

            // Polyfill for the isInteger function that will be added in ES6
            // http://wiki.ecmascript.org/doku.php?id=harmony:number.isinteger
            if (!Number.isInteger) {
                Number.isInteger = isInteger;
            }

            _export("default", {
                checkType: checkType,
                checkDefined: checkDefined,
                isArray: isArray,
                isDefined: isDefined,
                isInteger: isInteger,
                isNumeric: isNumeric,
                isString: isString,
                isType: isType,
                contains: contains,
                isValidUid: isValidUid
            });
        }
    };
});
System.register("d2/logger/Logger", ["d2/lib/check"], function (_export) {
    var checkType, isType, _createClass, _classCallCheck, console, Logger;

    return {
        setters: [function (_d2LibCheck) {
            checkType = _d2LibCheck.checkType;
            isType = _d2LibCheck.isType;
        }],
        execute: function () {
            "use strict";

            _createClass = (function () { function defineProperties(target, props) { for (var key in props) { var prop = props[key]; prop.configurable = true; if (prop.value) prop.writable = true; } Object.defineProperties(target, props); } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

            _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

            Logger = (function () {
                function Logger(logging) {
                    _classCallCheck(this, Logger);

                    checkType(logging, "object", "console");
                    console = logging;
                }

                _createClass(Logger, {
                    canLog: {
                        value: function canLog(type) {
                            return !!(type && console && isType(console[type], "function"));
                        }
                    },
                    debug: {
                        value: function debug() {
                            for (var _len = arguments.length, rest = Array(_len), _key = 0; _key < _len; _key++) {
                                rest[_key] = arguments[_key];
                            }

                            if (this.canLog("debug")) {
                                console.debug.apply(console, rest);
                                return true;
                            }
                            return false;
                        }
                    },
                    error: {
                        value: function error() {
                            for (var _len = arguments.length, rest = Array(_len), _key = 0; _key < _len; _key++) {
                                rest[_key] = arguments[_key];
                            }

                            if (this.canLog("error")) {
                                console.log(arguments);
                                console.error.apply(console, rest);
                                return true;
                            }
                            return false;
                        }
                    },
                    log: {
                        value: function log() {
                            for (var _len = arguments.length, rest = Array(_len), _key = 0; _key < _len; _key++) {
                                rest[_key] = arguments[_key];
                            }

                            if (this.canLog("log")) {
                                console.log.apply(console, rest);
                                return true;
                            }
                            return false;
                        }
                    },
                    warn: {
                        value: function warn() {
                            for (var _len = arguments.length, rest = Array(_len), _key = 0; _key < _len; _key++) {
                                rest[_key] = arguments[_key];
                            }

                            if (this.canLog("warn")) {
                                console.warn.apply(console, rest);
                                return true;
                            }
                            return false;
                        }
                    }
                });

                return Logger;
            })();

            Logger.getLogger = function () {
                var console;

                //TODO: This is not very clean try to figure out a better way to do this.
                try {
                    //Node version
                    console = global.console;
                } catch (e) {
                    //Browser version fallback
                    console = window.console;
                }

                if (this.logger) {
                    return this.logger;
                }
                return this.logger = new Logger(console);
            };

            _export("default", Logger);
        }
    };
});
/* global global */
System.register("d2/external/jquery", [], function (_export) {
  return {
    setters: [],
    execute: function () {
      "use strict";

      _export("default", window.jQuery);
    }
  };
});
System.register("d2/model/Model", ["d2/lib/check", "d2/model/ModelBase"], function (_export) {
  var checkType, ModelBase, _createClass, _classCallCheck, Model;

  return {
    setters: [function (_d2LibCheck) {
      checkType = _d2LibCheck.checkType;
    }, function (_d2ModelModelBase) {
      ModelBase = _d2ModelModelBase["default"];
    }],
    execute: function () {
      "use strict";

      _createClass = (function () { function defineProperties(target, props) { for (var key in props) { var prop = props[key]; prop.configurable = true; if (prop.value) prop.writable = true; } Object.defineProperties(target, props); } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

      _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

      //TODO: Perhaps we can generate model classes dynamically based on the schemas and inherit from this.
      /**
       * @class Model
       * @extends ModelBase
       *
       * @description
       * A Model represents an object from the DHIS2 Api. A model is created based of a ModelDefinition. The ModelDefinition
       * has the properties that the model should have.
       */

      Model = (function () {

        /**
         * @constructor
         *
         * @param {ModelDefinition} modelDefinition The model definition that corresponds with the model.
         * This is essential defining what type the model is representing.
         *
         * @description
         * Will create a new model instanced based on the model definition. When creating a new instance the model
         * definition needs to have both the modelValidations and modelProperties.
         *
         * The model properties will depend on the ModelDefinition. A model definition is based on a DHIS2 Schema.
         */

        function Model(modelDefinition) {
          _classCallCheck(this, Model);

          checkType(modelDefinition, "object", "modelDefinition");
          checkType(modelDefinition.modelProperties, "object", "modelProperties");

          /**
           * @property {ModelDefinition} modelDefinition Stores reference to the modelDefinition that was used when
           * creating the model. This property is not enumerable or writable and will therefore not show up when looping
           * over the object properties.
           */
          Object.defineProperty(this, "modelDefinition", {
            enumerable: false,
            configurable: false,
            writable: false,
            value: modelDefinition
          });

          /**
           * @property {Boolean} dirty Represents the state of the model. When the model is concidered `dirty`
           * there are pending changes.
           * This property is not enumerable or writable and will therefore not show up when looping
           * over the object properties.
           */
          Object.defineProperty(this, "dirty", {
            enumerable: false,
            configurable: false,
            writable: true,
            value: false
          });

          /**
           * @property {Object} dataValues Values object used to store the actual model values. Normally access to the
           * Model data will be done through accessor properties that are generated from the modelDefinition.
           *
           * @note {warning} This should not be accessed directly.
           */
          Object.defineProperty(this, "dataValues", {
            enumerable: false,
            configurable: true,
            writable: true,
            value: {}
          });

          Object.defineProperties(this, modelDefinition.modelProperties);
        }

        _createClass(Model, null, {
          create: {

            /**
             * @method create
             * @static
             *
             * @param {ModelDefinition} modelDefinition ModelDefinition from which the model should be created
             * @returns {Model} Returns an instance of the model.
             *
             * @description The static method is a factory method to create Model objects. It calls `new Model()` with the passed `ModelDefinition`.
             *
             * ```js
             * let myModel = Model.create(modelDefinition);
             * ```
             */

            value: function create(modelDefinition) {
              return new Model(modelDefinition);
            }
          }
        });

        return Model;
      })();

      Model.prototype = ModelBase;

      _export("default", Model);
    }
  };
});

/**
 * @module Model
 *
 * @requires lib/check
 * @requires model/ModelBase
 */
System.register("d2/pager/Pager", ["d2/lib/check"], function (_export) {
  var isDefined, _createClass, _classCallCheck, Pager;

  return {
    setters: [function (_d2LibCheck) {
      isDefined = _d2LibCheck.isDefined;
    }],
    execute: function () {
      "use strict";

      _createClass = (function () { function defineProperties(target, props) { for (var key in props) { var prop = props[key]; prop.configurable = true; if (prop.value) prop.writable = true; } Object.defineProperties(target, props); } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

      _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

      /**
       * @class Pager
       *
       * @description
       * Pager object that can be used to navigate pages within a `Modelcollection`
       */

      Pager = (function () {

        /**
         * @constructor
         *
         * @param {Object} [pager={page: 1, pageCount: 1}] Paging information object.
         * @param {Object} [pagingHandler={list: () => Promise.reject('No handler available')}] Paging handler object. The requirement for this object is that it has a list method.
         *
         * @description
         * Returns a newly created pager object with methods to navigate pages.
         */

        function Pager() {
          var pager = arguments[0] === undefined ? { page: 1, pageCount: 1 } : arguments[0];
          var pagingHandler = arguments[1] === undefined ? { list: function () {
              return Promise.reject("No handler available");
            } } : arguments[1];

          _classCallCheck(this, Pager);

          /**
           * @property {number} page Current page number
           */
          this.page = pager.page;

          /**
           * @property {number} pageCount The total number of pages available
           */
          this.pageCount = pager.pageCount;

          /**
           * @property {number} total The total number of items available.
           *
           * @description
           * This represents the total number of items available in the system. Note it is not the number of items
           * on the current page.
           */
          this.total = pager.total;

          /**
           * @property {string} nextPage The url to the next page.
           *
           * @description
           * If there is no next page then this will be undefined.
           */
          this.nextPage = pager.nextPage;

          /**
           * @property {string} prevPage The url to the previous page
           *
           * @description
           * If there is no previous page then this will be undefined.
           */
          this.prevPage = pager.prevPage;

          this.pagingHandler = pagingHandler;
        }

        _createClass(Pager, {
          hasNextPage: {

            /**
             * @method hasNextPage
             *
             * @returns {Boolean} Result is true when there is a next page, false when there is not.
             *
             * @description
             * Check whether there is a next page.
             */

            value: function hasNextPage() {
              return isDefined(this.nextPage);
            }
          },
          hasPreviousPage: {

            /**
             * @method hasPreviousPage
             *
             * @returns {Boolean} Result is true when there is a previous page, false when there is not.
             *
             * @description
             * Check whether there is a previous page.
             */

            value: function hasPreviousPage() {
              return isDefined(this.prevPage);
            }
          },
          getNextPage: {

            /**
             * @method getNextPage
             *
             * @returns {Promise} Promise that resolves with a new `ModelCollection` containing the next page's data. Or rejects with
             * a string when there is no next page for this collection or when the request for the next page failed.
             */

            value: function getNextPage() {
              if (this.hasNextPage()) {
                return this.goToPage(this.page + 1);
              }
              return Promise.reject("There is no next page for this collection");
            }
          },
          getPreviousPage: {

            /**
             * @method getPreviousPage
             *
             * @returns {Promise} Promise that resolves with a new `ModelCollection` containing the previous page's data. Or rejects with
             * a string when there is no previous page for this collection or when the request for the previous page failed.
             */

            value: function getPreviousPage() {
              if (this.hasPreviousPage()) {
                return this.goToPage(this.page - 1);
              }
              return Promise.reject("There is no previous page for this collection");
            }
          },
          goToPage: {

            /**
             * @method goToPage
             *
             * @param {Number} pageNr The number of the page you wish to navigate to.
             * @returns {Promise} Promise that resolves with a new `ModelCollection` containing the data for the requested page.
             */
            //TODO: Throwing the errors here is not really consistent with the rejection of promises for the getNextPage and getPreviousPage

            value: function goToPage(pageNr) {
              if (pageNr < 1) {
                throw new Error("PageNr can not be less than 1");
              }
              if (pageNr > this.pageCount) {
                throw new Error("PageNr can not be larger than the total page count of " + this.pageCount);
              }

              return this.pagingHandler.list({ page: pageNr });
            }
          }
        });

        return Pager;
      })();

      _export("default", Pager);
    }
  };
});
System.register("d2/lib/SchemaTypes", ["d2/lib/utils", "d2/lib/check"], function (_export) {
    var throwError, isString, _createClass, _classCallCheck, SchemaTypes;

    return {
        setters: [function (_d2LibUtils) {
            throwError = _d2LibUtils.throwError;
        }, function (_d2LibCheck) {
            isString = _d2LibCheck.isString;
        }],
        execute: function () {
            "use strict";

            _createClass = (function () { function defineProperties(target, props) { for (var key in props) { var prop = props[key]; prop.configurable = true; if (prop.value) prop.writable = true; } Object.defineProperties(target, props); } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

            _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

            SchemaTypes = (function () {
                function SchemaTypes() {
                    _classCallCheck(this, SchemaTypes);
                }

                _createClass(SchemaTypes, {
                    getTypes: {
                        value: function getTypes() {
                            return ["TEXT", "NUMBER", "INTEGER", "BOOLEAN", "EMAIL", "PASSWORD", "URL", "PHONENUMBER", "GEOLOCATION", //TODO: Geo location could be an advanced type of 2 numbers / strings?
                            "COLOR", "COMPLEX", "COLLECTION", "REFERENCE", "DATE", "COMPLEX", "IDENTIFIER", "CONSTANT"];
                        }
                    },
                    typeLookup: {
                        value: function typeLookup(propertyType) {
                            if (this.getTypes().indexOf(propertyType) >= 0 && isString(propertyType)) {

                                return propertyType;
                            }
                            throwError(["Type from schema \"", propertyType, "\" not found available type list."].join(""));
                        }
                    }
                });

                return SchemaTypes;
            })();

            _export("default", new SchemaTypes());
        }
    };
});
System.register("d2/model/ModelDefinitions", ["d2/lib/check"], function (_export) {
    var checkType, _createClass, _classCallCheck, ModelDefinitions;

    return {
        setters: [function (_d2LibCheck) {
            checkType = _d2LibCheck.checkType;
        }],
        execute: function () {
            "use strict";

            _createClass = (function () { function defineProperties(target, props) { for (var key in props) { var prop = props[key]; prop.configurable = true; if (prop.value) prop.writable = true; } Object.defineProperties(target, props); } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

            _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

            /**
             * @class ModelDefinitions
             *
             * @description
             * Contains all the `ModelDefinition`s that are available. The definitions are properties on the object.
             * This would be used as a main entry point to do any interaction.
             *
             * After calling the initialise function `d2({baseUrl: 'dhis/api'})` this object is the `models` property
             * that allows you to access
             *
             * ```js
             * models.dataElement.getList();
             * ```
             */

            ModelDefinitions = (function () {
                function ModelDefinitions() {
                    _classCallCheck(this, ModelDefinitions);
                }

                _createClass(ModelDefinitions, {
                    add: {
                        //TODO: Elaborate this documentation
                        /**
                         * @method add
                         * @param {ModelDefinition} modelDefinition Add a model definition to the definitions collection
                         *
                         * @description
                         * This will allow you to add your own custom ModelDefinitions.
                         *
                         * The Definition object should have the following properties
                         * `modelName, modelNamePlural, modelOptions, properties, validations`
                         *
                         * ```js
                         * models.add({name: 'MyDefinition', plural: 'MyDefinitions', endPointname: '/myDefinition'});
                         * ```
                         */

                        value: function add(modelDefinition) {
                            try {
                                checkType(modelDefinition.name, "string");
                            } catch (e) {
                                throw new Error("Name should be set on the passed ModelDefinition to add one");
                            }

                            if (this[modelDefinition.name]) {
                                throw new Error(["Model", modelDefinition.name, "already exists"].join(" "));
                            }
                            this[modelDefinition.name] = modelDefinition;
                        }
                    },
                    mapThroughDefinitions: {

                        /**
                         * @method mapThroughDefinitions
                         *
                         * @param {Function} transformer Transformer function that will be run for each `ModelDefinition`
                         * @returns {Array} Array with the `ModelDefinition` objects.
                         *
                         * @description
                         * Map through the modelDefinitions like you would with a simple `Array.map()`
                         *
                         * ```js
                         * models.mapThroughDefinitions(definition => console.log(definition.name);
                         * ```
                         *
                         * @note {info} When mapping through the definition list `transformer` is called with the just the definition
                         * Unlike other map functions, no index or the full object is being passed.
                         *
                         * @note {warn} The resulting array contains references to the actual objects. It does not work like immutable array functions.
                         *
                         */

                        value: function mapThroughDefinitions(transformer) {
                            var modelDefinition;
                            var result = [];

                            for (modelDefinition in this) {
                                if (this.hasOwnProperty(modelDefinition)) {
                                    result.push(transformer(this[modelDefinition]));
                                }
                            }

                            return result;
                        }
                    }
                });

                return ModelDefinitions;
            })();

            _export("default", ModelDefinitions);
        }
    };
});
System.register("d2/api/Api", ["d2/lib/check", "d2/lib/utils", "d2/external/jquery"], function (_export) {
    var checkType, copyOwnProperties, jQuery, _createClass, _classCallCheck, Api;

    function getApi() {
        if (getApi.api) {
            return getApi.api;
        }
        return getApi.api = new Api(jQuery);
    }

    function processSuccess(resolve) {
        return function (data /*, textStatus, jqXHR*/) {
            resolve(data);
        };
    }

    function processFailure(reject) {
        return function (jqXHR /*, textStatus, errorThrown*/) {
            delete jqXHR.then;
            reject(jqXHR);
        };
    }

    function getUrl(baseUrl, url) {
        //If we are dealing with an absolute url use that instead
        if (new RegExp("^(:?https?:)?//").test(url)) {
            return url;
        }

        var urlParts = [];

        if (baseUrl) {
            urlParts.push(baseUrl);
        }
        urlParts.push(url);

        return urlParts.join("/").replace(new RegExp("(.(?:[^:]))//+", "g"), "$1/").replace(new RegExp("/$"), "");
    }

    return {
        setters: [function (_d2LibCheck) {
            checkType = _d2LibCheck.checkType;
        }, function (_d2LibUtils) {
            copyOwnProperties = _d2LibUtils.copyOwnProperties;
        }, function (_d2ExternalJquery) {
            jQuery = _d2ExternalJquery["default"];
        }],
        execute: function () {
            "use strict";

            _createClass = (function () { function defineProperties(target, props) { for (var key in props) { var prop = props[key]; prop.configurable = true; if (prop.value) prop.writable = true; } Object.defineProperties(target, props); } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

            _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

            Api = (function () {
                function Api(jquery) {
                    _classCallCheck(this, Api);

                    this.jquery = jquery;
                    this.baseUrl = "/api";
                    this.defaultRequestSettings = {
                        data: {},
                        contentType: "application/json",
                        dataType: "json",
                        type: undefined,
                        url: undefined
                    };
                }

                _createClass(Api, {
                    get: {
                        value: function get(url, data) {
                            return this.request("GET", getUrl(this.baseUrl, url), data);
                        }
                    },
                    post: {
                        value: function post(url, data) {
                            return this.request("POST", getUrl(this.baseUrl, url), JSON.stringify(data));
                        }
                    },
                    remove: {
                        value: function remove() {}
                    },
                    update: {

                        //TODO: write tests for update

                        value: function update(url, data) {
                            return this.request("PUT", url, JSON.stringify(data));
                        }
                    },
                    request: {
                        value: function request(type, url, data) {
                            checkType(type, "string", "Request type");
                            checkType(url, "string", "Url");

                            var api = this;

                            return new Promise(function (resolve, reject) {
                                api.jquery.ajax(getOptions({
                                    type: type,
                                    url: url,
                                    data: data || {}
                                })).then(processSuccess(resolve), processFailure(reject));
                            });

                            function getOptions(mergeOptions) {
                                var options = {};

                                copyOwnProperties(options, api.defaultRequestSettings);
                                copyOwnProperties(options, mergeOptions);

                                return options;
                            }
                        }
                    },
                    setBaseUrl: {
                        value: function setBaseUrl(baseUrl) {
                            checkType(baseUrl, "string", "Base url");

                            this.baseUrl = baseUrl;

                            return this;
                        }
                    }
                });

                return Api;
            })();

            Api.getApi = getApi;
            _export("default", Api);
        }
    };
});
System.register("d2/model/ModelCollection", ["d2/lib/check", "d2/lib/utils", "d2/model/Model", "d2/model/ModelDefinition", "d2/pager/Pager"], function (_export) {
    var isValidUid, isArray, checkType, throwError, Model, ModelDefinition, Pager, _toConsumableArray, _createClass, _classCallCheck, ModelCollection;

    function throwIfContainsOtherThanModelObjects(values) {
        if (values && values[Symbol.iterator]) {
            var toCheck = [].concat(_toConsumableArray(values));
            toCheck.forEach(function (value) {
                if (!(value instanceof Model)) {
                    throwError("Values of a ModelCollection must be instances of Model");
                }
            });
        }
    }

    function throwIfContainsModelWithoutUid(values) {
        if (values && values[Symbol.iterator]) {
            var toCheck = [].concat(_toConsumableArray(values));
            toCheck.forEach(function (value) {
                if (!isValidUid(value.id)) {
                    throwError("Can not add a Model without id to a ModelCollection");
                }
            });
        }
    }

    return {
        setters: [function (_d2LibCheck) {
            isValidUid = _d2LibCheck.isValidUid;
            isArray = _d2LibCheck.isArray;
            checkType = _d2LibCheck.checkType;
        }, function (_d2LibUtils) {
            throwError = _d2LibUtils.throwError;
        }, function (_d2ModelModel) {
            Model = _d2ModelModel["default"];
        }, function (_d2ModelModelDefinition) {
            ModelDefinition = _d2ModelModelDefinition["default"];
        }, function (_d2PagerPager) {
            Pager = _d2PagerPager["default"];
        }],
        execute: function () {
            "use strict";

            _toConsumableArray = function (arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) arr2[i] = arr[i]; return arr2; } else { return Array.from(arr); } };

            _createClass = (function () { function defineProperties(target, props) { for (var key in props) { var prop = props[key]; prop.configurable = true; if (prop.value) prop.writable = true; } Object.defineProperties(target, props); } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

            _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

            /**
             * @class ModelCollection
             *
             * @description
             * Collection of `Model` objects that can be interacted upon. Can contain a pager object to easily navigate
             * pages within the system.
             */

            ModelCollection = (function () {

                /**
                 * @constructor
                 *
                 * @param {ModelDefinition} modelDefinition The `ModelDefinition` that this collection is for. This defines the type of models that
                 * are allowed to be added to the collection.
                 * @param {Model[]} values Initial values that should be added to the collection.
                 * @param {Object} pagerData Object with pager data. This object contains data that will be put into the `Pager` instance.
                 *
                 * @description
                 *
                 * Creates a new `ModelCollection` object based on the passed `modelDefinition`. Additionally values can be added by passing
                 * `Model` objects in the `values` parameter. The collection also exposes a pager object which can be used to navigate through
                 * the pages in the collection. For more information see the `Pager` class.
                 */

                function ModelCollection(modelDefinition, values, pagerData) {
                    var _this = this;

                    _classCallCheck(this, ModelCollection);

                    checkType(modelDefinition, ModelDefinition);
                    /**
                     * @property {ModelDefinition} modelDefinition The `ModelDefinition` that this collection is for. This defines the type of models that
                     * are allowed to be added to the collection.
                     */
                    this.modelDefinition = modelDefinition;

                    /**
                     * @property {Pager} pager Pager object that is created from the pagerData that was passed when the collection was constructed. If no pager data was present
                     * the pager will have default values.
                     */
                    this.pager = new Pager(pagerData, modelDefinition);

                    //We can not extend the Map object right away in v8 contexts.
                    this.valuesContainerMap = new Map();
                    this[Symbol.iterator] = this.valuesContainerMap[Symbol.iterator].bind(this.valuesContainerMap);

                    throwIfContainsOtherThanModelObjects(values);
                    throwIfContainsModelWithoutUid(values);

                    //Add the values separately as not all Iterators return the same values
                    if (isArray(values)) {
                        values.forEach(function (value) {
                            return _this.add(value);
                        });
                    }
                }

                _createClass(ModelCollection, {
                    size: {

                        /**
                         * @property {Number} size The number of Model objects that are in the collection.
                         *
                         * @description
                         * Contains the number of Model objects that are in this collection. If the collection is a collection with a pager. This
                         * does not take into account all the items in the database. Therefore when a pager is present on the collection
                         * the size will return the items on that page. To get the total number of items consult the pager.
                         */

                        get: function () {
                            return this.valuesContainerMap.size;
                        }
                    },
                    add: {

                        /**
                         * @method add
                         *
                         * @param {Model} value Model instance to add to the collection.
                         * @returns {ModelCollection} Returns itself for chaining purposes.
                         *
                         * @throws {Error} When the passed value is not an instance of `Model`
                         * @throws {Error} Throws error when the passed value does not have a valid id.
                         *
                         * @description
                         * Adds a Model instance to the collection. The model is checked if it is a correct instance of `Model` and if it has
                         * a valid id. A valid id is a uid string of 11 alphanumeric characters.
                         */

                        value: function add(value) {
                            throwIfContainsOtherThanModelObjects([value]);
                            throwIfContainsModelWithoutUid([value]);

                            this.set(value.id, value);
                            return this;
                        }
                    },
                    toArray: {

                        /**
                         * @method toArray
                         *
                         * @returns {Array} Returns the values of the collection as an array.
                         *
                         * @description
                         * If working with the Map type object is inconvenient this method can be used to return the values
                         * of the collection as an Array object.
                         */

                        value: function toArray() {
                            var resultArray = [];

                            this.forEach(function (model) {
                                resultArray.push(model);
                            });

                            return resultArray;
                        }
                    },
                    clear: {

                        /**
                         * @method clear
                         *
                         * @returns {this} Returns itself for chaining purposes;
                         *
                         * @description
                         * Clear the collection and remove all it's values.
                         */
                        //TODO: Reset the pager?

                        value: function clear() {
                            return this.valuesContainerMap.clear.apply(this.valuesContainerMap);
                        }
                    },
                    "delete": {
                        value: function _delete() {
                            for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
                                args[_key] = arguments[_key];
                            }

                            return this.valuesContainerMap["delete"].apply(this.valuesContainerMap, args);
                        }
                    },
                    entries: {
                        value: function entries() {
                            return this.valuesContainerMap.entries.apply(this.valuesContainerMap);
                        }
                    },
                    forEach: {

                        //FIXME: This calls the forEach function with the values Map and not with the ModelCollection as the third argument

                        value: function forEach() {
                            for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
                                args[_key] = arguments[_key];
                            }

                            return this.valuesContainerMap.forEach.apply(this.valuesContainerMap, args);
                        }
                    },
                    get: {
                        value: function get() {
                            for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
                                args[_key] = arguments[_key];
                            }

                            return this.valuesContainerMap.get.apply(this.valuesContainerMap, args);
                        }
                    },
                    has: {
                        value: function has() {
                            for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
                                args[_key] = arguments[_key];
                            }

                            return this.valuesContainerMap.has.apply(this.valuesContainerMap, args);
                        }
                    },
                    keys: {
                        value: function keys() {
                            return this.valuesContainerMap.keys.apply(this.valuesContainerMap);
                        }
                    },
                    set: {
                        value: function set() {
                            for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
                                args[_key] = arguments[_key];
                            }

                            return this.valuesContainerMap.set.apply(this.valuesContainerMap, args);
                        }
                    },
                    values: {
                        value: function values() {
                            return this.valuesContainerMap.values.apply(this.valuesContainerMap);
                        }
                    }
                }, {
                    create: {
                        value: function create(modelDefinition, values, pagerData) {
                            return new ModelCollection(modelDefinition, values, pagerData);
                        }
                    }
                });

                return ModelCollection;
            })();

            _export("default", ModelCollection);
        }
    };
});
System.register("d2/model/ModelValidation", ["d2/lib/check", "d2/logger/Logger", "d2/api/Api"], function (_export) {
    var checkType, isInteger, isObject, isArray, isString, isNumeric, Logger, Api, _createClass, _classCallCheck, logger, typeSpecificValidations, ModelValidation, phoneNumberRegEx;

    //TODO: See if we can reduce the complexity of this function
    function typeValidation(value, type) {
        //jshint maxcomplexity: 16
        switch (type) {
            case "INTEGER":
                return isInteger(value);
            case "NUMBER":
                return isNumeric(value);
            case "COLLECTION":
                return isArray(value); // || isModelCollection();
            case "PHONENUMBER":
            case "EMAIL":
            case "URL":
            case "COLOR":
            case "PASSWORD":
            case "IDENTIFIER":
            case "TEXT":
                return isString(value);
            case "COMPLEX":
                return isObject(value);
            case "DATE":
            case "REFERENCE":
            case "BOOLEAN":
            case "CONSTANT":
                return true;
            default:
                //TODO: Add logger for d2?
                //TODO: Perhaps this should throw?
                logger.log("No type validator found for", type);
        }
        return false;
    }

    function numberMinMaxValidation(value, validationSettings) {
        var resultStatus = { status: true, messages: [] };

        if (isNumeric(value)) {
            if (!isLargerThanMin(value, validationSettings.min)) {
                resultStatus.status = false;
                resultStatus.messages.push({
                    message: ["Value needs to be larger than or equal to", validationSettings.min].join(" "),
                    value: value
                });
            }

            if (!isSmallerThanMax(value, validationSettings.max)) {
                resultStatus.status = false;
                resultStatus.messages.push({
                    message: ["Value needs to be smaller than or equal to", validationSettings.max].join(" "),
                    value: value
                });
            }
        }

        return resultStatus;
    }

    function minMaxValidation(result, value, validationSettings) {
        var numberMinMaxValidationStatus = numberMinMaxValidation(value, validationSettings);
        if (!numberMinMaxValidationStatus.status) {
            result.status = false;
            result.messages = result.messages.concat(numberMinMaxValidationStatus.messages);
        }

        var lengthMinMaxValidationStatus = lengthMinMaxValidation(value, validationSettings);
        if (!lengthMinMaxValidationStatus.status) {
            result.status = false;
            result.messages = result.messages.concat(lengthMinMaxValidationStatus.messages);
        }

        return result;
    }

    function lengthMinMaxValidation(value, validationSettings) {
        var resultStatus = { status: true, messages: [] };

        if (isArray(value) || isString(value)) {
            if (!isLargerThanLength(value, validationSettings.min)) {
                resultStatus.status = false;
                resultStatus.messages.push({
                    message: ["Value needs to be longer than or equal to", validationSettings.min].join(" "),
                    value: value
                });
            }

            if (!isSmallerThanLength(value, validationSettings.max)) {
                resultStatus.status = false;
                resultStatus.messages.push({
                    message: ["Value needs to be shorter than or equal to", validationSettings.max].join(" "),
                    value: value
                });
            }
        }

        return resultStatus;
    }

    function isLargerThanMin(value, minValue) {
        return isNumeric(minValue) ? value >= minValue : true;
    }

    function isSmallerThanMax(value, maxValue) {
        return isNumeric(maxValue) ? value <= maxValue : true;
    }

    function isLargerThanLength(value, minValue) {
        if (!isInteger(minValue)) {
            return true;
        }
        return Boolean(value && isInteger(value.length) && value.length >= minValue);
    }

    function isSmallerThanLength(value, maxValue) {
        if (!isInteger(maxValue)) {
            return true;
        }
        return Boolean(value && isInteger(value.length) && value.length <= maxValue);
    }

    function typeSpecificValidation(result, value, valueType) {
        if (!valueType || !isArray(typeSpecificValidations[valueType])) {
            return result;
        }

        result.status = typeSpecificValidations[valueType].reduce(function (currentValidationStatus, customValidator) {
            if (!customValidator.validator.apply(null, [value])) {
                result.messages.push({
                    message: customValidator.message,
                    value: value
                });
                currentValidationStatus = false;
            }
            return currentValidationStatus;
        }, true);
    }

    function phoneNumber(value) {
        return phoneNumberRegEx.test(value);
    }

    return {
        setters: [function (_d2LibCheck) {
            checkType = _d2LibCheck.checkType;
            isInteger = _d2LibCheck.isInteger;
            isObject = _d2LibCheck.isObject;
            isArray = _d2LibCheck.isArray;
            isString = _d2LibCheck.isString;
            isNumeric = _d2LibCheck.isNumeric;
        }, function (_d2LoggerLogger) {
            Logger = _d2LoggerLogger["default"];
        }, function (_d2ApiApi) {
            Api = _d2ApiApi["default"];
        }],
        execute: function () {
            "use strict";

            _createClass = (function () { function defineProperties(target, props) { for (var key in props) { var prop = props[key]; prop.configurable = true; if (prop.value) prop.writable = true; } Object.defineProperties(target, props); } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

            _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

            logger = undefined;
            typeSpecificValidations = {
                PHONENUMBER: [{
                    message: "Phone number can only consist of numbers and + and [space]",
                    validator: phoneNumber
                }]
            };

            /**
             * @class ModelValidation
             */

            ModelValidation = (function () {
                function ModelValidation(providedLogger) {
                    _classCallCheck(this, ModelValidation);

                    checkType(providedLogger, "object", "logger (Logger)");
                    logger = providedLogger;
                }

                _createClass(ModelValidation, {
                    validate: {

                        /**
                         * @method validate
                         *
                         * @param {Object} validationSettings
                         * @param {*} value The value to be validated
                         * @returns {{status: boolean, messages: Array}} Returns an object with the status. When the status is false the messages
                         * array will contain messages on why the validation failed.
                         *
                         * @description
                         * Validate a given value against the given validationSettings.
                         * This checks if the value is of the defined `validationSettings.type`
                         * if the value adheres to the set `validationSettings.min` and `validationSettings.max`
                         * and runs any type specific validations like for example on the type PHONENUMBER if it is [0-9+ ] compliant.
                         */
                        //TODO: By default we validate min/max as correct for anything other than array, string and number

                        value: function validate(validationSettings, value) {
                            if (!isObject(validationSettings)) {
                                throw new TypeError("validationSettings should be of type object");
                            }
                            var result = { status: true, messages: [] };

                            //No value when not required is a valid value.
                            if (validationSettings.required === false && !value) {
                                return { status: true, messages: [] };
                            }

                            if (!typeValidation(value, validationSettings.type)) {
                                result.status = false;
                                result.messages.push({
                                    message: "This is not a valid type",
                                    value: value
                                });
                            }

                            minMaxValidation(result, value, validationSettings);
                            typeSpecificValidation(result, value, validationSettings.type);

                            return result;
                        }
                    },
                    validateAgainstSchema: {

                        /**
                         * @method validateAgainstSchema
                         *
                         * @param {Model} model The model that should be validated.
                         * @returns {Array} Returns an array with validation messages if there are any.
                         *
                         * @description
                         * Sends a POST request against the `api/schemas` endpoint to check if the model is valid.
                         *
                         * @note {warn} Currently only checks
                         */

                        value: function validateAgainstSchema(model) {
                            if (!(model && model.modelDefinition && model.modelDefinition.name)) {
                                return Promise.reject("model.modelDefinition.name can not be found");
                            }

                            return Api.getApi().post(["schemas", model.modelDefinition.name].join("/"), model.modelDefinition.getOwnedPropertyJSON(model));
                        }
                    }
                }, {
                    getModelValidation: {

                        /**
                         * @method getModelValidation
                         * @static
                         *
                         * @returns {ModelValidation} New or memoized instance of `ModelInstance`
                         *
                         * @description
                         * Returns the `ModelValidation` singleton. Creates a new one if it does not yet exist.
                         * Grabs a logger instance by calling `Logger.getLogger`
                         */

                        value: function getModelValidation() {
                            if (this.modelValidation) {
                                return this.modelValidation;
                            }
                            return this.modelValidation = new ModelValidation(Logger.getLogger(console));
                        }
                    }
                });

                return ModelValidation;
            })();

            phoneNumberRegEx = /^[0-9\+ ]+$/;

            _export("default", ModelValidation);
        }
    };
});
/* global console */
System.register("d2/model/ModelDefinition", ["d2/lib/check", "d2/lib/utils", "d2/model/Model", "d2/model/ModelCollection", "d2/lib/SchemaTypes"], function (_export) {
    var checkType, isObject, checkDefined, addLockedProperty, curry, Model, ModelCollection, schemaTypes, _get, _inherits, _createClass, _classCallCheck, ModelDefinition, UserModelDefinition;

    function createPropertiesObject(schemaProperties) {
        var propertiesObject = {};
        var createModelPropertyDescriptorOn = curry(createModelPropertyDescriptor, propertiesObject);

        (schemaProperties || []).forEach(createModelPropertyDescriptorOn);

        return propertiesObject;
    }

    function createModelPropertyDescriptor(propertiesObject, schemaProperty) {
        var propertyName = schemaProperty.collection ? schemaProperty.collectionName : schemaProperty.name;
        var propertyDetails = {
            //Actual property descriptor properties
            configurable: false,
            enumerable: true,
            get: function get() {
                return this.dataValues[propertyName];
            }
        };

        //Only add a setter for writable properties
        if (schemaProperty.writable) {
            propertyDetails.set = function (value) {

                //TODO: Objects and Arrays are concidered unequal when their data is the same and therefore trigger a dirty
                if (!isObject(value) && value !== this.dataValues[propertyName] || isObject(value)) {
                    this.dirty = true;
                    this.dataValues[propertyName] = value;
                }
            };
        }

        if (propertyName) {
            propertiesObject[propertyName] = propertyDetails;
        }
    }

    function createValidations(schemaProperties) {
        var validationsObject = {};
        var createModelPropertyOn = curry(createValidationSetting, validationsObject);

        (schemaProperties || []).forEach(createModelPropertyOn);

        return validationsObject;
    }

    function createValidationSetting(validationObject, schemaProperty) {
        var propertyName = schemaProperty.collection ? schemaProperty.collectionName : schemaProperty.name;
        var validationDetails = {
            persisted: schemaProperty.persisted,
            type: schemaTypes.typeLookup(schemaProperty.propertyType),
            required: schemaProperty.required,
            min: schemaProperty.min,
            max: schemaProperty.max,
            owner: schemaProperty.owner,
            unique: schemaProperty.unique,
            writable: schemaProperty.writable,
            constants: schemaProperty.constants
        };

        //Add a referenceType to be able to get a hold of the reference objects model.
        //This is the java class name converted to a d2 model name
        if (validationDetails.type === "REFERENCE") {
            validationDetails.referenceType = getReferenceTypeFrom(schemaProperty);
        }

        if (propertyName) {
            validationObject[propertyName] = validationDetails;
        }

        //TODO: Simplify this when it is easier to grab the type of the reference
        function getReferenceTypeFrom(schemaProperty) {
            var classPart = undefined;
            var owningRolePart = undefined;

            try {
                classPart = schemaProperty.klass.split(".").reverse()[0];
                owningRolePart = schemaProperty.owningRole.split(".").reverse()[0];
            } catch (e) {
                return undefined;
            }

            if (isStringContains(classPart, owningRolePart)) {
                return lowerCaseFirstLetter(owningRolePart);
            }

            if (isStringContains(owningRolePart, classPart)) {
                return lowerCaseFirstLetter(classPart);
            }

            return undefined;

            function isStringContains(text, contains) {
                return text.toLowerCase().indexOf(contains.toLowerCase()) >= 0;
            }

            function lowerCaseFirstLetter(text) {
                return text.charAt(0).toLowerCase() + text.slice(1);
            }
        }
    }

    return {
        setters: [function (_d2LibCheck) {
            checkType = _d2LibCheck.checkType;
            isObject = _d2LibCheck.isObject;
            checkDefined = _d2LibCheck.checkDefined;
        }, function (_d2LibUtils) {
            addLockedProperty = _d2LibUtils.addLockedProperty;
            curry = _d2LibUtils.curry;
        }, function (_d2ModelModel) {
            Model = _d2ModelModel["default"];
        }, function (_d2ModelModelCollection) {
            ModelCollection = _d2ModelModelCollection["default"];
        }, function (_d2LibSchemaTypes) {
            schemaTypes = _d2LibSchemaTypes["default"];
        }],
        execute: function () {
            "use strict";

            _get = function get(object, property, receiver) { var desc = Object.getOwnPropertyDescriptor(object, property); if (desc === undefined) { var parent = Object.getPrototypeOf(object); if (parent === null) { return undefined; } else { return get(parent, property, receiver); } } else if ("value" in desc && desc.writable) { return desc.value; } else { var getter = desc.get; if (getter === undefined) { return undefined; } return getter.call(receiver); } };

            _inherits = function (subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) subClass.__proto__ = superClass; };

            _createClass = (function () { function defineProperties(target, props) { for (var key in props) { var prop = props[key]; prop.configurable = true; if (prop.value) prop.writable = true; } Object.defineProperties(target, props); } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

            _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

            /**
             * @class ModelDefinition
             *
             * @description
             * Definition of a Model. Basically this object contains the meta data related to the Model. Like `name`, `apiEndPoint`, `modelValidation`, etc.
             * It also has methods to create and load Models that are based on this definition. The Data element `ModelDefinition` would be used to create Data Element `Model`s
             *
             * Note: ModelDefinition has a property `api` that is used for the communication with the dhis2 api. The value of this
             * property is an instance of `Api`.
             */

            ModelDefinition = (function () {
                function ModelDefinition(modelName, modelNamePlural, modelOptions, properties, validations) {
                    _classCallCheck(this, ModelDefinition);

                    checkType(modelName, "string");
                    checkType(modelNamePlural, "string", "Plural");

                    addLockedProperty(this, "name", modelName);
                    addLockedProperty(this, "plural", modelNamePlural);
                    addLockedProperty(this, "isMetaData", modelOptions && modelOptions.metadata || false);
                    addLockedProperty(this, "apiEndpoint", modelOptions && modelOptions.apiEndpoint);
                    addLockedProperty(this, "modelProperties", properties);
                    addLockedProperty(this, "modelValidations", validations);
                }

                _createClass(ModelDefinition, {
                    create: {

                        /**
                         * @method create
                         *
                         * @param {Object} [data] Datavalues that should be loaded into the model.
                         *
                         * @returns {Model} Returns the newly created model instance.
                         *
                         * @description
                         * Creates a fresh Model instance based on the `ModelDefinition`. If data is passed into the method that
                         * data will be loaded into the matching properties of the model.
                         *
                         * ```js
                         * dataElement.create({name: 'ANC', id: 'd2sf33s3ssf'});
                         * ```
                         */

                        value: function create(data) {
                            var model = Model.create(this);

                            if (data) {
                                //Set the datavalues onto the model directly
                                Object.keys(model).forEach(function (key) {
                                    model.dataValues[key] = data[key];
                                });
                            }

                            return model;
                        }
                    },
                    get: {

                        /**
                         * @method get
                         *
                         * @param {String} identifier
                         * @param {Object} [queryParams={fields: ':all'}] Query parameters that should be passed to the GET query.
                         * @returns {Promise} Resolves with a `Model` instance or an error message.
                         *
                         * @description
                         * Get a `Model` instance from the api loaded with data that relates to `identifier`.
                         * This will do an API call and return a Promise that resolves with a `Model` or rejects with the api error message.
                         *
                         * ```js
                         * //Do a get request for the dataElement with given id (d2sf33s3ssf) and print it's name
                         * //when that request is complete and the model is loaded.
                         * dataElement.get('d2sf33s3ssf')
                         *   .then(model => console.log(model.name));
                         * ```
                         */

                        value: function get(identifier) {
                            var _this = this;

                            var queryParams = arguments[1] === undefined ? { fields: ":all" } : arguments[1];

                            checkDefined(identifier, "Identifier");

                            //TODO: should throw error if API has not been defined
                            return this.api.get([this.apiEndpoint, identifier].join("/"), queryParams).then(function (data) {
                                return _this.create(data);
                            })["catch"](function (response) {
                                return Promise.reject(response.data);
                            });
                        }
                    },
                    list: {

                        /**
                         * @method list
                         *
                         * @param {Object} [queryParams={fields: ':all'}] Query parameters that should be passed to the GET query.
                         * @returns {ModelCollection} Collection of model objects of the `ModelDefinition` type.
                         *
                         * @description
                         * Loads a list of models.
                         *
                         * ```js
                         * // Loads a list of models and prints their name.
                         * dataElement.list()
                         *   .then(modelCollection => {
                         *     modelCollection.forEach(model => console.log(model.name));
                         *   });
                         * ```
                         */

                        value: function list() {
                            var _this = this;

                            var queryParams = arguments[0] === undefined ? { fields: ":all" } : arguments[0];

                            return this.api.get(this.apiEndpoint, queryParams).then(function (data) {
                                return ModelCollection.create(_this, data[_this.plural].map(function (data) {
                                    return _this.create(data);
                                }), data.pager);
                            });
                        }
                    },
                    save: {

                        /**
                         * @method save
                         *
                         * @param {Model} model The model that should be saved to the server.
                         * @returns {Promise} A promise which resolves when the save was successful
                         * or rejects when it failed. The promise will resolve with the data that is
                         * returned from the server.
                         *
                         * @description
                         * This method is used by the `Model` instances to save the model when calling `model.save()`.
                         *
                         * @note {warning} This should generally not be accessed directly.
                         */
                        //TODO: check the return status of the save to see if it was actually successful and not ignored

                        value: function save(model) {
                            var isAnUpdate = function (model) {
                                return !!model.id;
                            };
                            if (isAnUpdate(model)) {
                                return this.api.update(model.dataValues.href, this.getOwnedPropertyJSON(model));
                            } else {
                                //Its a new object
                                return this.api.post(this.apiEndpoint, this.getOwnedPropertyJSON(model));
                            }
                        }
                    },
                    getOwnedPropertyJSON: {
                        value: function getOwnedPropertyJSON(model) {
                            var objectToSave = {};
                            var ownedProperties = this.getOwnedPropertyNames();

                            Object.keys(this.modelValidations).forEach(function (propertyName) {
                                if (ownedProperties.includes(propertyName)) {
                                    if (model.dataValues[propertyName]) {
                                        objectToSave[propertyName] = model.dataValues[propertyName];
                                    }
                                }
                            });

                            return objectToSave;
                        }
                    },
                    getOwnedPropertyNames: {

                        /**
                         * @method getOwnedPropertyNames
                         *
                         * @returns {String[]} Returns an array of property names.
                         *
                         * @description
                         * This method returns a list of property names that that are defined
                         * as "owner" properties on this schema. This means these properties are used
                         * when saving the model to the server.
                         *
                         * ```js
                         * dataElement.getOwnedPropertyNames()
                         * ```
                         */

                        value: function getOwnedPropertyNames() {
                            var _this = this;

                            return Object.keys(this.modelValidations).filter(function (propertyName) {
                                return _this.modelValidations[propertyName].owner;
                            });
                        }
                    }
                }, {
                    createFromSchema: {

                        /**
                         * @method createFromSchema
                         * @static
                         *
                         * @returns {ModelDefinition} Frozen model definition object.
                         *
                         * @description
                         * This method creates a new `ModelDefinition` based on a JSON structure called
                         * a schema. A schema represents the structure of a domain model as it is
                         * required by DHIS. Since these schemas can not be altered on the server from
                         * the modelDefinition is frozen to prevent accidental changes to the definition.
                         *
                         * ```js
                         * ModelDefinition.createFromSchema(schemaDefinition);
                         * ```
                         *
                         * @note {info} An example of a schema definition can be found on
                         * https://apps.dhis2.org/demo/api/schemas/dataElement
                         */

                        value: function createFromSchema(schema) {
                            var ModelDefinitionClass = undefined;
                            checkType(schema, Object, "Schema");

                            if (typeof ModelDefinition.specialClasses[schema.name] === "function") {
                                ModelDefinitionClass = ModelDefinition.specialClasses[schema.name];
                            } else {
                                ModelDefinitionClass = ModelDefinition;
                            }

                            return Object.freeze(new ModelDefinitionClass(schema.name, schema.plural, schema, Object.freeze(createPropertiesObject(schema.properties)), Object.freeze(createValidations(schema.properties))));
                        }
                    }
                });

                return ModelDefinition;
            })();

            UserModelDefinition = (function (_ModelDefinition) {
                function UserModelDefinition() {
                    _classCallCheck(this, UserModelDefinition);

                    if (_ModelDefinition != null) {
                        _ModelDefinition.apply(this, arguments);
                    }
                }

                _inherits(UserModelDefinition, _ModelDefinition);

                _createClass(UserModelDefinition, {
                    get: {
                        value: function get(identifier) {
                            var queryParams = arguments[1] === undefined ? { fields: ":all,userCredentials[:owner]" } : arguments[1];

                            return _get(Object.getPrototypeOf(UserModelDefinition.prototype), "get", this).call(this, identifier, queryParams);
                        }
                    }
                });

                return UserModelDefinition;
            })(ModelDefinition);

            ModelDefinition.specialClasses = {
                user: UserModelDefinition
            };
            _export("default", ModelDefinition);
        }
    };
});
System.register("d2/model/ModelBase", ["d2/model/ModelValidation"], function (_export) {
    var ModelValidation, _createClass, _classCallCheck, modelValidator, ModelBase;

    return {
        setters: [function (_d2ModelModelValidation) {
            ModelValidation = _d2ModelModelValidation["default"];
        }],
        execute: function () {
            "use strict";

            _createClass = (function () { function defineProperties(target, props) { for (var key in props) { var prop = props[key]; prop.configurable = true; if (prop.value) prop.writable = true; } Object.defineProperties(target, props); } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

            _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

            modelValidator = ModelValidation.getModelValidation();

            /**
             * @class ModelBase
             */

            ModelBase = (function () {
                function ModelBase() {
                    _classCallCheck(this, ModelBase);
                }

                _createClass(ModelBase, {
                    save: {
                        /**
                         * @method save
                         *
                         * @returns {Promise} Returns a promise that resolves when the model has been saved
                         * or rejects with the result from the `validate()` call.
                         *
                         * @description
                         * Checks if the model is dirty. When the model is dirty it will check if the values of the model are valid by calling
                         * `validate`. If this is correct it will attempt to save the [Model](#/model/Model) to the api.
                         *
                         * ```js
                         * myModel.save()
                         *   .then((message) => console.log(message));
                         * ```
                         */

                        value: function save() {
                            var _this = this;

                            if (!this.dirty) {
                                return Promise.reject("No changes to be saved");
                            }

                            return this.validate().then(function (validationState) {
                                if (!validationState.status) {
                                    return Promise.reject(validationState);
                                }

                                return _this.modelDefinition.save(_this).then(function () {
                                    return _this.dirty = false;
                                });
                            });
                        }
                    },
                    validate: {

                        /**
                         * @method validate
                         *
                         * @returns {Promise} Promise that resolves with an object with a status property that represents if the model
                         * is valid or not the fields array will return the names of the fields that are invalid.
                         *
                         * @description
                         * This will run the validations on the properties which have validations set. Normally these validations are defined
                         * through the DHIS2 schema. It will check min/max for strings/numbers etc. Additionally it will
                         * run model validations against the schema.
                         *
                         * ```js
                         * myModel.validate()
                         *  .then(myModelStatus => {
                         *    if (myModelStatus.status === false) {
                         *      myModelStatus.fields.forEach((fieldName) => console.log(fieldName));
                         *    }
                         * });
                         * ```
                         */

                        value: function validate() {
                            var _this = this;

                            return new Promise(function (resolve, reject) {
                                var modelValidationStatus = true;
                                var validationMessages = [];
                                var validationState = undefined;

                                //Run local validation on the models data values
                                validationMessages = validationMessages.concat(localValidation(_this.modelDefinition.modelValidations, _this.dataValues));

                                //Run async validation against the api
                                asyncRemoteValidation(_this).then(function (remoteMessages) {
                                    validationMessages = validationMessages.concat(remoteMessages);

                                    validationState = {
                                        status: modelValidationStatus,
                                        fields: validationMessages.map(function (validationMessage) {
                                            return validationMessage.property;
                                        }).reduce(unique, []),
                                        messages: validationMessages
                                    };
                                    resolve(validationState);
                                })["catch"](function (message) {
                                    return reject(message);
                                });

                                function unique(current, property) {
                                    if (property && current.indexOf(property) === -1) {
                                        current.push(property);
                                    }
                                    return current;
                                }

                                function localValidation(modelValidations, dataValues) {
                                    var validationMessagesLocal = [];

                                    Object.keys(modelValidations).forEach(function (propertyName) {
                                        var validationStatus = modelValidator.validate(modelValidations[propertyName], dataValues[propertyName]);
                                        if (!validationStatus.status) {
                                            validationStatus.messages.forEach(function (message) {
                                                message.property = propertyName;
                                            });
                                        }
                                        modelValidationStatus = modelValidationStatus && validationStatus.status;
                                        validationMessagesLocal = validationMessagesLocal.concat(validationStatus.messages || []);
                                    });

                                    return validationMessagesLocal;
                                }

                                function asyncRemoteValidation(model) {
                                    return modelValidator.validateAgainstSchema(model);
                                }
                            });
                        }
                    }
                });

                return ModelBase;
            })();

            _export("default", new ModelBase());
        }
    };
});
System.register("d2/model/models", ["d2/model/ModelBase", "d2/model/Model", "d2/model/ModelDefinition", "d2/model/ModelDefinitions", "d2/model/ModelValidation"], function (_export) {
    var ModelBase, Model, ModelDefinition, ModelDefinitions, ModelValidation;
    return {
        setters: [function (_d2ModelModelBase) {
            ModelBase = _d2ModelModelBase["default"];
        }, function (_d2ModelModel) {
            Model = _d2ModelModel["default"];
        }, function (_d2ModelModelDefinition) {
            ModelDefinition = _d2ModelModelDefinition["default"];
        }, function (_d2ModelModelDefinitions) {
            ModelDefinitions = _d2ModelModelDefinitions["default"];
        }, function (_d2ModelModelValidation) {
            ModelValidation = _d2ModelModelValidation["default"];
        }],
        execute: function () {
            "use strict";

            _export("default", {
                ModelBase: ModelBase,
                Model: Model,
                ModelDefinition: ModelDefinition,
                ModelDefinitions: ModelDefinitions,
                ModelValidations: ModelValidation
            });
        }
    };
});
System.register("d2", ["d2/lib/utils", "d2/lib/check", "d2/logger/Logger", "d2/model/models", "d2/api/Api"], function (_export) {
    var pick, checkType, isString, Logger, model, Api;

    /**
     * @function d2Init
     *
     * @param {Object} config Configuration object that will be used to configure to define D2 Setting.
     * See the description for more information on the available settings.
     * @returns {Promise} A promise that resolves with the intialized d2 object. Which is an object that exposes `model`, `models` and `Api`
     *
     * @description
     * Init function that used to initialise D2. This will load the schemas from the DHIS2 api and configure your D2 instance.
     *
     * The `options` object that can be passed into D2 can have the following properties:
     *
     * baseUrl: Set this when the url is something different then `/api`. If you are running your dhis instance in a subdirectory of the actual domain
     * for example http://localhost/dhis/ you should set the base url to `/dhis/api`
     *
     * ```js
     * import d2Init from 'd2';
     *
     * d2Init({baseUrl: '/dhis/api'})
     *   .then((d2) => {
     *     console.log(d2.model.dataElement.list());
     *   });
     * ```
     */
    function d2Init(config) {
        var logger = Logger.getLogger();

        var d2 = {
            models: undefined,
            model: model,
            Api: Api
        };

        var api = Api.getApi();

        if (config && checkType(config, "object", "Config parameter")) {
            processConfig(api, config);
        }

        model.ModelDefinition.prototype.api = api;

        d2.models = new model.ModelDefinitions();

        return api.get("schemas").then(pick("schemas")).then(function (schemas) {
            schemas.forEach(function (schema) {
                d2.models.add(model.ModelDefinition.createFromSchema(schema));
            });

            return d2;
        })["catch"](function (error) {
            logger.error("Unable to get schemas from the api", error);

            return Promise.reject(error);
        });
    }

    function processConfig(api, config) {
        if (isString(config.baseUrl)) {
            api.setBaseUrl(config.baseUrl);
        } else {
            api.setBaseUrl("/api");
        }
    }

    return {
        setters: [function (_d2LibUtils) {
            pick = _d2LibUtils.pick;
        }, function (_d2LibCheck) {
            checkType = _d2LibCheck.checkType;
            isString = _d2LibCheck.isString;
        }, function (_d2LoggerLogger) {
            Logger = _d2LoggerLogger["default"];
        }, function (_d2ModelModels) {
            model = _d2ModelModels["default"];
        }, function (_d2ApiApi) {
            Api = _d2ApiApi["default"];
        }],
        execute: function () {
            "use strict";

            if (typeof window !== "undefined") {
                window.d2 = d2Init;
            }

            _export("default", d2Init);
        }
    };
});
});