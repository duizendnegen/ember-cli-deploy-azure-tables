/* jshint node: true */
'use strict';

var DeployPluginBase  = require('ember-cli-deploy-plugin');
var azure             = require('azure-storage');
var Promise           = require('rsvp').Promise;

var fs                = require('fs');
var path              = require('path');

var denodeify         = require('rsvp').denodeify;
var readFile          = denodeify(fs.readFile);

var AZURE_TABLE_NAME        = 'emberdeploy';
var AZURE_MANIFEST_TAG      = 'manifest';

module.exports = {
  name: 'ember-cli-deploy-azure-tables',

  createDeployPlugin: function(options) {
    var DeployPlugin = DeployPluginBase.extend({
      name: options.name,

      defaultConfig: {
          tableName: AZURE_TABLE_NAME,
          manifestTag: AZURE_MANIFEST_TAG
      },

      _createClient: function() {
        var connectionString = this.readConfig("connectionString");
        var storageAccount = this.readConfig("storageAccount");
        var storageAccessKey = this.readConfig("storageAccessKey");

        if(connectionString) {
          return azure.createTableService(connectionString);
        } else if(storageAccount && storageAccessKey) {
          return azure.createTableService(storageAccount, storageAccessKey);
        } else {
          throw new Error("Missing connection string or storage account / access key combination.");
        }
      },

      _key: function(context) {
        var revisionKey = context.commandOptions.revision || context.revisionData.revisionKey.substr(0, 8);
        return context.project.name() + ':' + revisionKey;
      },

      configure: function(context) {
        this._super.configure.apply(this, context);

        if(!this.pluginConfig.connectionString) {
          ['storageAccount', 'storageAccessKey'].forEach(this.ensureConfigPropertySet.bind(this));
        }

        ['tableName', 'manifestTag', 'manifestSize'].forEach(this.applyDefaultConfigProperty.bind(this));
      },

      fetchInitialRevisions: function(context) {
        return this._list(context).then(function(revisions) {
          return {
            initialRevisions: revisions
          };
        });
      },

      fetchRevisions: function(context) {
        return this._list(context).then(function(revisions) {
          return {
            revisions: revisions
          };
        });
      },

      upload: function(context) {
        var self = this;
        var client = this._createClient();
        var key = this._key(context);

        var tableName = this.readConfig('tableName');
        var manifestTag = this.readConfig('manifestTag');

        this.log('deploying index.html to Azure Tables...');

        return readFile(path.join(context.distDir, "index.html"))
      	.then(function(buffer) {
      		return buffer.toString();
      	}).then(function(indexContents) {
          return new Promise(function(resolve, reject) {
            // create table if not already existent
            client.createTableIfNotExists(tableName, function(error, result, response) {
              if(!error){
                var query = new azure.TableQuery()
                        .where('PartitionKey eq ?', manifestTag)
                        .and('RowKey eq ?', key);

                // find the list of uploaded revisions
                client.queryEntities(tableName, query, null, function(error, result, response) {
                  if(!error){
                    // has this key already been uploaded once?
                    if(result.entries.length > 0) {
                      reject("Key already in manifest - revision already uploaded or collided.");
                    } else {
                      var entGen = azure.TableUtilities.entityGenerator;
                      var entity = {};
                      entity["PartitionKey"] = entGen.String(manifestTag);
                      entity["RowKey"] = entGen.String(key);
                      entity["content"] = entGen.String(indexContents);

                      client.insertEntity(tableName, entity,  function (error, result, response) {
                        if(!error){
                          resolve(result);
                        } else {
                          reject(error);
                        }
                      });
                    }
                  } else {
                    reject(error);
                  }
                });
              } else {
                reject(error);
              }
            });
          });
        });
      },

      didDeploy: function(context){
        var key = this._key(context);
        this.log("deployed index.html under " + key);
      },

      willActivate: function(context) {
        return this._current(context).then(function(current) {
          if(!context.revisionData) {
            context.revisionData = {};
          }
          context.revisionData.previousRevisionKey = current;
        });
      },

      activate: function(context) {
        var client = this._createClient();
        var key = this._key(context);
        var _this = this;

        var tableName = this.readConfig('tableName');
        var manifestTag = this.readConfig('manifestTag');

        return new Promise(function(resolve, reject) {
          _this._list(context).then(function(existingEntries) {
            if(existingEntries.some(function(entry) {
              return entry.revision === key;
            })) {
              return true;
            } else {
              reject("Revision " + key + " not in manifest");
              return false;
            }
          })
          .then(function() {
            var entGen = azure.TableUtilities.entityGenerator;
            var entity = {};
            entity["PartitionKey"] = entGen.String(manifestTag);
            entity["RowKey"] = entGen.String(context.project.name() + ":current");
            entity["content"] = entGen.String(key);

            client.insertOrReplaceEntity(tableName, entity,  function (error, result, response) {
              if(!error){
                resolve(result);
              } else {
                reject(error);
              }
            });
          });
        }).then(function() {
          if(!context.revisionData) {
            context.revisionData = {};
          }
          context.revisionData.activatedRevisionKey = key;
        });
      },
      didActivate: function(context) {
        var key = this._key(context);

        this.log("Activated revision " + key);
      },
      _currentKey: function(context) {
        return context.project.name() + ':current';
      },
      _current: function(context) {
        var client = this._createClient();

        var tableName = this.readConfig('tableName');
        var manifestTag = this.readConfig('manifestTag');

        return new Promise(function(resolve, reject) {
          // create table if not already existent
          client.createTableIfNotExists(tableName, function(error, result, response) {
            if(!error){
              // find the current tag
              var query = new azure.TableQuery()
                      .where('PartitionKey eq ?', manifestTag)
                      .and('RowKey eq ?', this._currentKey(context));

              // find the list of uploaded revisions
              client.queryEntities(tableName, query, null, function(error, result, response) {
                if(!error){
                  if(result && result.entries.length > 0) {
                    resolve(result.entries[0]["content"]["_"]);
                  } else {
                    resolve(null);
                  }
                } else {
                  reject(error);
                }
              });
            } else {
              reject(error);
            }
          }.bind(this));
        }.bind(this));
      },
      _list: function(context) {
        var client = this._createClient();

        var tableName = this.readConfig('tableName');
        var manifestTag = this.readConfig('manifestTag');

        return this._current(context).then(function(current) {
          return new Promise(function(resolve, reject) {
            // create table if not already existent
            client.createTableIfNotExists(tableName, function(error, result, response) {
              if(!error){
                var query = new azure.TableQuery()
                        .where('PartitionKey eq ?', manifestTag)
                        .and('RowKey ne ?', this._currentKey(context));

                this._query(client, null, query, [], resolve, reject, current);
              } else {
                reject(error);
              }
            }.bind(this));
          }.bind(this));
        }.bind(this));
      },
      _query: function(client, continuationToken, query, entries, resolve, reject, current) {
        var tableName = this.readConfig('tableName');
        var manifestTag = this.readConfig('manifestTag');

        client.queryEntities(tableName, query, continuationToken, function(error, result, response) {
          if(!error) {
            for(var i = 0, len = result.entries.length; i < len; ++i) {
              entries.push(result.entries[i]);
            }

            continuationToken = result.continuationToken;

            if(!continuationToken) {
              var sortedEntries = entries;

              sortedEntries.sort(function(a, b) {
                return new Date(b["Timestamp"]["_"]).getTime() - new Date(a["Timestamp"]["_"]).getTime();
              });

              var mappedEntries = sortedEntries.map(function(entry) {
                var revision = entry["RowKey"]["_"];
                return { revision: revision, timestamp: new Date(entry["Timestamp"]["_"]).getTime(), active: current === revision };
              });

              resolve(mappedEntries);
            } else {
              this._query(client, continuationToken, query, entries, resolve, reject, current);
            }
          } else {
            reject(error);
          }
        }.bind(this));
      }
    });

    return new DeployPlugin();
  }
};
