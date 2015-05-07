'use strict';

var dhisOptions = {
    url: 'https://apps.dhis2.org/demo/api',
    username: 'admin',
    password: 'district',
    initialised: false
};
var initializedD2;

var window = {
    //TODO: Fake jQuery using the fetch api that is available in WebKit and Chrome. We should be able to remove this
    //once d2 does not depend on jQuery anymore.
    jQuery: {
        ajax: function (ajaxConfig) {
            var requestOptions = {
                headers: {
                    'Authorization': 'Basic ' + self.btoa([dhisOptions.username, dhisOptions.password].join(':')),
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                method: (ajaxConfig.type || 'GET').toLowerCase(),
            };

            if (ajaxConfig.type === 'POST') {
                requestOptions.body = ajaxConfig.data;
            }

            var request = fetch(ajaxConfig.url, requestOptions);

            return request
                .then(function (response) {
                    return response.json();
                })
                .catch(function (response) {
                    console.log('Failed to execute request to the server: ' + dhisOptions.url + ' with config', ajaxConfig);
                });
        }
    },
    console: console
};

//Import the scripts after setting the window object
//TODO: we can not assume that these are always in this location..
onmessage = function (message) {
    if (message.data.type === 'init') {
        parseOptions(message.data.options);

        initD2()
            .then(function () {
                dhisOptions.initialised = true;
                console.log('D2 Initialisation complete');

                postMessage('init-complete');
            })
            .catch(function (error) {
                console.log('Failed to initialise d2')
                console.log(error)
            });
        return;
    }

    if (!dhisOptions.initialised) {
        console.error('D2 Instance not yet initialised');
        return;
    }

    try {
        var exampleFunction = new Function('d2', message.data);
    } catch (e) {
        console.error(e.stack);
    }

    initializedD2
        .then(exampleFunction)
        .then(postDone, postError);
}

function postDone() {
    postMessage('done');
}

function postError(e) {
    console.error && console.error(e);
    postMessage('error');
}

function parseOptions(options) {
    dhisOptions.url = options.url || dhisOptions.url;
    dhisOptions.username = options.username || dhisOptions.username;
    dhisOptions.password = options.password || dhisOptions.password;
    options.scripts = options.scripts || ['/d2-sfx.js', 'https://cdnjs.cloudflare.com/ajax/libs/es6-shim/0.31.0/es6-shim.js'];

    importScripts.apply(this, options.scripts);
}

function initD2() {
    return initializedD2 = window.d2({
        baseUrl: dhisOptions.url
    });
}