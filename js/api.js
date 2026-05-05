// js/api.js — minimal fetch wrappers with auto-auth
(function() {
  'use strict';

  var _auth = null;

  function _getAuthHeaders() {
    if (_auth && typeof _auth.getApiHeaders === 'function') {
      return _auth.getApiHeaders();
    }
    if (window.Auth && typeof window.Auth.getApiHeaders === 'function') {
      return window.Auth.getApiHeaders();
    }
    return { 'Content-Type': 'application/json' };
  }

  function _request(method, url, body) {
    var opts = { method: method, headers: _getAuthHeaders() };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    return fetch(url, opts).then(function(res) {
      return res.json().then(function(data) {
        return { ok: res.ok, status: res.status, data: data };
      }).catch(function() {
        return { ok: res.ok, status: res.status, data: null };
      });
    });
  }

  var api = {

    injectAuth: function(authObj) {
      _auth = authObj;
    },

    get: function(url) {
      return _request('GET', url);
    },

    post: function(url, body) {
      return _request('POST', url, body);
    },

    put: function(url, body) {
      return _request('PUT', url, body);
    },

    del: function(url) {
      return _request('DELETE', url);
    }

  };

  window.api = api;
})();
