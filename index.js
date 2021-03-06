var fs = require('fs');
var path = require('path');
var RSVP = require('rsvp');
var mkdirp = require('mkdirp')
var walkSync = require('walk-sync');
var quickTemp = require('quick-temp')
var Writer = require('broccoli-writer');
var helpers = require('broccoli-kitchen-sink-helpers');


var canLink = testCanLink();

CachingWriter.prototype = Object.create(Writer.prototype);
CachingWriter.prototype.constructor = CachingWriter;
function CachingWriter (inputTree, options) {
  if (!(this instanceof CachingWriter)) return new CachingWriter(inputTree, options);

  this.inputTree = inputTree;
  this._shouldBeIgnoredCache = Object.create(null);

  options = options || {};

  for (var key in options) {
    if (options.hasOwnProperty(key)) {
      this[key] = options[key];
    }
  }

  if (this.filterFromCache === undefined) {
    this.filterFromCache = {};
  }

  if (this.filterFromCache.include === undefined) {
    this.filterFromCache.include = [];
  }

  if (this.filterFromCache.exclude === undefined) {
    this.filterFromCache.exclude = [];
  }

  if (!Array.isArray(this.filterFromCache.include)) {
    throw new Error("Invalid filterFromCache.include option, it must be an array or undefined.")
  }

  if (!Array.isArray(this.filterFromCache.exclude)) {
    throw new Error("Invalid filterFromCache.exclude option, it must be an array or undefined.")
  }
};

CachingWriter.prototype.getCacheDir = function () {
  return quickTemp.makeOrReuse(this, 'tmpCacheDir');
};

CachingWriter.prototype.getCleanCacheDir = function () {
  return quickTemp.makeOrRemake(this, 'tmpCacheDir');
};

CachingWriter.prototype.write = function (readTree, destDir) {
  var self = this;

  return readTree(this.inputTree).then(function (srcDir) {
    var inputTreeKeys = self.keysForTree(srcDir);
    var inputTreeHash = helpers.hashStrings(inputTreeKeys);

    return RSVP.resolve()
      .then(function() {
        var updateCacheResult;

        if (inputTreeHash !== self._cacheHash) {
          updateCacheResult = self.updateCache(srcDir, self.getCleanCacheDir());

          self._cacheHash     = inputTreeHash;
          self._cacheTreeKeys = inputTreeKeys;
        }

        return updateCacheResult;
      })
      .finally(function() {
        linkFromCache(self.getCacheDir(), destDir);
      });
  });
};

CachingWriter.prototype.cleanup = function () {
  quickTemp.remove(this, 'tmpCacheDir');
  Writer.prototype.cleanup.call(this);
};

CachingWriter.prototype.updateCache = function (srcDir, destDir) {
  throw new Error('You must implement updateCache.');
};

// Takes in a path and { include, exclude }. Tests the path using regular expressions and
// returns true if the path does not match any exclude patterns AND matches atleast
// one include pattern.
CachingWriter.prototype.shouldBeIgnored = function (fullPath) {
  if (this._shouldBeIgnoredCache[fullPath] !== undefined) {
    return this._shouldBeIgnoredCache[fullPath];
  }

  var excludePatterns = this.filterFromCache.exclude;
  var includePatterns = this.filterFromCache.include;
  var i = null;

  // Check exclude patterns
  for (i = 0; i < excludePatterns.length; i++) {
    // An exclude pattern that returns true should be ignored
    if (excludePatterns[i].test(fullPath) === true) {
      return this._shouldBeIgnoredCache[fullPath] = true;
    }
  }

  // Check include patterns
  if (includePatterns !== undefined && includePatterns.length > 0) {
    for (i = 0; i < includePatterns.length; i++) {
      // An include pattern that returns true (and wasn't excluded at all)
      // should _not_ be ignored
      if (includePatterns[i].test(fullPath) === true) {
        return this._shouldBeIgnoredCache[fullPath] = false;
      }
    }

    // If no include patterns were matched, ignore this file.
    return this._shouldBeIgnoredCache[fullPath] = true;
  }

  // Otherwise, don't ignore this file
  return this._shouldBeIgnoredCache[fullPath] = false;
}


CachingWriter.prototype.keysForTree = function (fullPath, initialRelativePath) {
  var relativePath   = initialRelativePath || '.'
  var stats;
  var statKeys;

  try {
    stats = fs.statSync(fullPath);
  } catch (err) {
    console.warn('Warning: failed to stat ' + fullPath);
    // fullPath has probably ceased to exist. Leave `stats` undefined and
    // proceed hashing.
  }
  var childKeys = [];
  if (stats) {
    statKeys = ['stats', stats.mode];
  } else {
    statKeys = ['stat failed'];
  }
  if (stats && stats.isDirectory()) {
    var fileIdentity = stats.dev + '\x00' + stats.ino;
    var entries;
    try {
      entries = fs.readdirSync(fullPath).sort();
    } catch (err) {
      console.warn('Warning: Failed to read directory ' + fullPath);
      console.warn(err.stack);
      childKeys = ['readdir failed'];
      // That's all there is to say about this directory.
    }
    if (entries != null) {
      for (var i = 0; i < entries.length; i++) {

        var keys = this.keysForTree(
          path.join(fullPath, entries[i]),
          path.join(relativePath, entries[i])
        );
        childKeys = childKeys.concat(keys);
      }
    }
  } else if (stats && stats.isFile()) {
    if (this.shouldBeIgnored(fullPath)) {
      return [];
    }
    statKeys.push(stats.mtime.getTime(), stats.size);
  }

  // Perhaps we should not use basename to infer the file name
  return ['path', relativePath]
    .concat(statKeys)
    .concat(childKeys);
}

module.exports = CachingWriter;


function linkFromCache (srcDir, destDir) {
  var files = walkSync(srcDir);
  var length = files.length;
  var file;

  for (var i = 0; i < length; i++) {
    file = files[i];

    var srcFile = path.join(srcDir, file);
    var stats   = fs.statSync(srcFile);

    if (stats.isDirectory()) { continue; }

    if (!stats.isFile()) { throw new Error('Can not link non-file.'); }

    destFile = path.join(destDir, file);
    mkdirp.sync(path.dirname(destFile));
    if (canLink) {
      fs.linkSync(srcFile, destFile);
    }
    else {
      fs.writeFileSync(destFile, fs.readFileSync(srcFile));
    }
  }
}

function testCanLink () {
  var canLinkSrc  = path.join(__dirname, "canLinkSrc.tmp");
  var canLinkDest = path.join(__dirname, "canLinkDest.tmp");

  try {
    fs.writeFileSync(canLinkSrc);
  } catch (e) {
    return false;
  }

  try {
    fs.linkSync(canLinkSrc, canLinkDest);
  } catch (e) {
    fs.unlinkSync(canLinkSrc);
    return false;
  }

  fs.unlinkSync(canLinkDest);

  return true;
}
