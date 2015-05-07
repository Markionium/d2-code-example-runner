'use strict';
import CodeMirror from 'codemirror';
import 'codemirror/mode/javascript/javascript';
import 'codemirror/addon/lint/lint';
import 'codemirror/addon/lint/javascript-lint';
import 'codemirror/addon/runmode/runmode';

let codeExamples = {
    init: init,
    all: initialiseExamples
};
let coderunner;
let initSuccess;
let initFailed;
let codeRunnerInitialized = new Promise(function (resolve, reject) {
    initSuccess = resolve;
    initFailed = reject;
});

function init(exampleRunner = 'src/examplerunner.js', options = {}) {
    addStylesToHead();

    //Start the worker that runs the example
    coderunner = new Worker(exampleRunner)
    coderunner.addEventListener('message', initListener);

    function initListener(event) {
        if (event.data === 'init-complete') {
            initSuccess();
        }
        coderunner.removeEventListener('message', initListener);
    }

    //Initialise the worker with the settings for api communication
    coderunner.postMessage({
        type: 'init',
        options: options
    });

    return codeExamples;
}

function initialiseExamples() {
    if (hasWebWorkerSupport() && hasFetchSupport()) {
        runnableCodeExamples();
        staticCodeExamples();
    } else {
        //TODO: Show a browser message thing that will notify user of no examples?
        console.info && console.info('No web worker and/or fetch support in this browser therefore we will render static examples only');
        staticCodeExamples(true);
    }
}

function addStylesToHead() {
    const stylesForCodeExamples = `
    .d2-runnable-code-example-run-button {
            width: 100%;
            -webkit-appearance: none;
            -moz-appearance: none;
            background: none;
            border: none;
            background: rgb(33,150,243);
            color: white;
            font-size: 1rem;
            padding: 6px;
        }

        .d2-static-code-example {
            padding: 1rem 2rem;
            border-left: .5rem solid;
            border-color: rgb(33,150,243);
        }

        .CodeMirror {
            height: auto;
        }
    `;

    let styleElement = document.createElement('style')
    styleElement.setAttribute('type', 'text/css')
    styleElement.textContent = stylesForCodeExamples;

    document.querySelector('head')
        .appendChild(styleElement);
}

function runnableCodeExamples() {
    const runnableCodeExampleElements = getRunnableCodeExamples();

    runnableCodeExampleElements
        .forEach(element => {
            let codeMirrorElement = document.createElement('div');
            let runButton = getRunButton();
            let options = getCodeMirrorOptions();
            let codeMirror;

            //Navigate to the node above the <pre>
            element.parentNode.parentNode.insertBefore(codeMirrorElement, element.parentNode);

            //Set the code as the value for codemirror
            options.value = element.textContent.trim() + "\n";

            //TODO: Code mirror needs to be run on the element that is already in the DOM?
            codeMirror = CodeMirror(codeMirrorElement, options);

            if (window.JSHINT) {
                let waiting;
                codeMirror.on('change', function() {
                    clearTimeout(waiting);
                    waiting = setTimeout(updateHints(codeMirror), 500);
                });

                setTimeout(updateHints(codeMirror), 100);
            }


            runButton.data = {
                codeMirror: codeMirror
            };

            codeMirrorElement.appendChild(runButton);

            element.style.display = 'none';
        });
}

function updateHints(editor) {
    return function () {
        editor.operation(function(){
            JSHINT(editor.getValue(), {esnext: true});
            for (var i = 0; i < JSHINT.errors.length; ++i) {
                var err = JSHINT.errors[i];
                if (!err) continue;

                //TODO: Do something to display the hints if JSHINT is available
                //console.info(`${err.line}: ${err.reason}`);
            }
        });
    }
}

function staticCodeExamples(includeRunnableAsStatic) {
    let exampleElements = getCodeExamples();

    if (includeRunnableAsStatic) {
        exampleElements = exampleElements.concat(getRunnableCodeExamples());
    }

    exampleElements.forEach(element => {
       CodeMirror.runMode(element.textContent + "\n", getCodeMirrorOptions(), element);

        element.parentNode.classList.add('cm-s-monokai', 'CodeMirror', 'd2-static-code-example');
    });
}

function hasWebWorkerSupport() {
    return !!window.Worker;
}

function hasFetchSupport() {
    return !!window.fetch;
}

function getRunnableCodeExamples() {
    return getNonEmptyCodeElementsWithClass('d2-runnable-code-example');
}

function getCodeExamples() {
    return getNonEmptyCodeElementsWithClass('d2-code-example');
}

function getNonEmptyCodeElementsWithClass(className) {
    let runnableCodeElements = Array.from(document.querySelectorAll('code.' + className));

    return runnableCodeElements
        .filter(element => element.textContent.trim());
}

function getCodeMirrorOptions() {
    return {
        name: 'javascript',
        lineNumbers: true,
        theme: 'monokai'
    };
}

function getRunButton() {
    let runButtonElement = document.createElement('button');
    runButtonElement.textContent = 'Initialising D2..';
    runButtonElement.disabled = true;
    runButtonElement.classList.add('d2-runnable-code-example-run-button');

    codeRunnerInitialized.then(function () {
        runButtonElement.textContent = 'Run!';
        runButtonElement.disabled = false;
    });

    runButtonElement.addEventListener('click', function (event) {
        if (this.data && this.data.codeMirror) {
            let element = this;
            let oldButtonText = this.textContent;
            let code = this.data.codeMirror.getValue();

            //If babel is available we transform the code
            if (window.babel) {
                code = babel.transform(code, {sourceMap: 'inline'}).code;
            }

            if (!code) { return; }

            //TODO: Change this for an addEventListener that de-registers
            coderunner.onmessage = () => {
                event.target.textContent = 'Run!';
            }

            this.textContent = 'Running...';
            coderunner.postMessage(code);
        }
    });

    return runButtonElement;
}

export default codeExamples;
