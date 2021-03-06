/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import type {
  Profile,
  Thread,
  SamplesTable,
  StackTable,
  ExtensionTable,
  FrameTable,
  FuncTable,
  MarkersTable,
  ResourceTable,
  IndexIntoFuncTable,
  IndexIntoStringTable,
  IndexIntoSamplesTable,
  IndexIntoMarkersTable,
  IndexIntoStackTable,
  ThreadIndex,
} from '../types/profile';
import type {
  CallNodeInfo,
  CallNodeTable,
  CallNodePath,
  IndexIntoCallNodeTable,
  TracingMarker,
} from '../types/profile-derived';
import type { BailoutPayload } from '../types/markers';
import { CURRENT_VERSION as GECKO_PROFILE_VERSION } from './gecko-profile-versioning';
import { CURRENT_VERSION as PROCESSED_PROFILE_VERSION } from './processed-profile-versioning';

import type { StartEndRange } from '../types/units';
import { timeCode } from '../utils/time-code';
import { hashPath } from '../utils/path';
import type { ImplementationFilter } from '../types/actions';
import bisection from 'bisection';
import type { UniqueStringArray } from '../utils/unique-string-array';

/**
 * Various helpers for dealing with the profile as a data structure.
 * @module profile-data
 */

export const resourceTypes = {
  unknown: 0,
  library: 1,
  addon: 2,
  webhost: 3,
  otherhost: 4,
  url: 5,
};

export const emptyExtensions: ExtensionTable = Object.freeze({
  id: Object.freeze([]),
  name: Object.freeze([]),
  baseURL: Object.freeze([]),
  length: 0,
});

/**
 * Generate the CallNodeInfo which contains the CallNodeTable, and a map to convert
 * an IndexIntoStackTable to a IndexIntoCallNodeTable. This function runs through
 * a stackTable, and de-duplicates stacks that have frames that point to the same
 * function.
 *
 * See `src/types/profile-derived.js` for the type definitions.
 * See `docs/call-trees.md` for a detailed explanation of CallNodes.
 */
export function getCallNodeInfo(
  stackTable: StackTable,
  frameTable: FrameTable,
  funcTable: FuncTable
): CallNodeInfo {
  return timeCode('getCallNodeInfo', () => {
    const stackIndexToCallNodeIndex = new Uint32Array(stackTable.length);
    const funcCount = funcTable.length;
    // Maps can't key off of two items, so combine the prefixCallNode and the funcIndex
    // using the following formula: prefixCallNode * funcCount + funcIndex => callNode
    const prefixCallNodeAndFuncToCallNodeMap = new Map();

    // The callNodeTable components.
    const prefix: Array<IndexIntoCallNodeTable> = [];
    const func: Array<IndexIntoFuncTable> = [];
    const depth: Array<number> = [];
    let length = 0;

    function addCallNode(
      prefixIndex: IndexIntoCallNodeTable,
      funcIndex: IndexIntoFuncTable
    ) {
      const index = length++;
      prefix[index] = prefixIndex;
      func[index] = funcIndex;
      if (prefixIndex === -1) {
        depth[index] = 0;
      } else {
        depth[index] = depth[prefixIndex] + 1;
      }
    }

    // Go through each stack, and create a new callNode table, which is based off of
    // functions rather than frames.
    for (let stackIndex = 0; stackIndex < stackTable.length; stackIndex++) {
      const prefixStack = stackTable.prefix[stackIndex];
      // We know that at this point the following condition holds:
      // assert(prefixStack === null || prefixStack < stackIndex);
      const prefixCallNode =
        prefixStack === null ? -1 : stackIndexToCallNodeIndex[prefixStack];
      const frameIndex = stackTable.frame[stackIndex];
      const funcIndex = frameTable.func[frameIndex];
      const prefixCallNodeAndFuncIndex = prefixCallNode * funcCount + funcIndex;
      let callNodeIndex = prefixCallNodeAndFuncToCallNodeMap.get(
        prefixCallNodeAndFuncIndex
      );
      if (callNodeIndex === undefined) {
        callNodeIndex = length;
        addCallNode(prefixCallNode, funcIndex);
        prefixCallNodeAndFuncToCallNodeMap.set(
          prefixCallNodeAndFuncIndex,
          callNodeIndex
        );
      }
      stackIndexToCallNodeIndex[stackIndex] = callNodeIndex;
    }

    const callNodeTable: CallNodeTable = {
      prefix: new Int32Array(prefix),
      func: new Int32Array(func),
      depth,
      length,
    };

    return { callNodeTable, stackIndexToCallNodeIndex };
  });
}

export function getSampleCallNodes(
  samples: SamplesTable,
  stackIndexToCallNodeIndex: {
    [key: IndexIntoStackTable]: IndexIntoCallNodeTable,
  }
): Array<IndexIntoCallNodeTable | null> {
  return samples.stack.map(stack => {
    return stack === null ? null : stackIndexToCallNodeIndex[stack];
  });
}

function _getTimeRangeForThread(
  thread: Thread,
  interval: number
): StartEndRange {
  if (thread.samples.length === 0) {
    return { start: Infinity, end: -Infinity };
  }
  return {
    start: thread.samples.time[0],
    end: thread.samples.time[thread.samples.length - 1] + interval,
  };
}

export function getTimeRangeIncludingAllThreads(
  profile: Profile
): StartEndRange {
  const completeRange = { start: Infinity, end: -Infinity };
  profile.threads.forEach(thread => {
    const threadRange = _getTimeRangeForThread(thread, profile.meta.interval);
    completeRange.start = Math.min(completeRange.start, threadRange.start);
    completeRange.end = Math.max(completeRange.end, threadRange.end);
  });
  return completeRange;
}

export function defaultThreadOrder(threads: Thread[]): ThreadIndex[] {
  // Put the compositor/renderer thread last.
  const threadOrder = threads.map((thread, i) => i);
  threadOrder.sort((a, b) => {
    const nameA = threads[a].name;
    const nameB = threads[b].name;
    if (nameA === nameB) {
      return a - b;
    }
    return nameA === 'Compositor' || nameA === 'Renderer' ? 1 : -1;
  });
  return threadOrder;
}

export function toValidImplementationFilter(
  implementation: string
): ImplementationFilter {
  switch (implementation) {
    case 'cpp':
    case 'js':
      return implementation;
    default:
      return 'combined';
  }
}

export function filterThreadByImplementation(
  thread: Thread,
  implementation: string
): Thread {
  const { funcTable, stringTable } = thread;

  switch (implementation) {
    case 'cpp':
      return _filterThreadByFunc(thread, funcIndex => {
        // Return quickly if this is a JS frame.
        if (funcTable.isJS[funcIndex]) {
          return false;
        }
        // Regular C++ functions are associated with a resource that describes the
        // shared library that these C++ functions were loaded from. Jitcode is not
        // loaded from shared libraries but instead generated at runtime, so Jitcode
        // frames are not associated with a shared library and thus have no resource
        const locationString = stringTable.getString(funcTable.name[funcIndex]);
        const isProbablyJitCode =
          funcTable.resource[funcIndex] === -1 &&
          locationString.startsWith('0x');
        return !isProbablyJitCode;
      });
    case 'js':
      return _filterThreadByFunc(
        thread,
        funcIndex => funcTable.isJS[funcIndex]
      );
    default:
      return thread;
  }
}

function _filterThreadByFunc(
  thread: Thread,
  filter: IndexIntoFuncTable => boolean
): Thread {
  return timeCode('filterThread', () => {
    const { stackTable, frameTable, samples } = thread;

    const newStackTable = {
      length: 0,
      frame: [],
      prefix: [],
    };

    const oldStackToNewStack = new Map();
    const frameCount = frameTable.length;
    const prefixStackAndFrameToStack = new Map(); // prefixNewStack * frameCount + frame => newStackIndex

    function convertStack(stackIndex) {
      if (stackIndex === null) {
        return null;
      }
      let newStack = oldStackToNewStack.get(stackIndex);
      if (newStack === undefined) {
        const prefixNewStack = convertStack(stackTable.prefix[stackIndex]);
        const frameIndex = stackTable.frame[stackIndex];
        const funcIndex = frameTable.func[frameIndex];
        if (filter(funcIndex)) {
          const prefixStackAndFrameIndex =
            (prefixNewStack === null ? -1 : prefixNewStack) * frameCount +
            frameIndex;
          newStack = prefixStackAndFrameToStack.get(prefixStackAndFrameIndex);
          if (newStack === undefined) {
            newStack = newStackTable.length++;
            newStackTable.prefix[newStack] = prefixNewStack;
            newStackTable.frame[newStack] = frameIndex;
          }
          oldStackToNewStack.set(stackIndex, newStack);
          prefixStackAndFrameToStack.set(prefixStackAndFrameIndex, newStack);
        } else {
          newStack = prefixNewStack;
        }
      }
      return newStack;
    }

    const newSamples = Object.assign({}, samples, {
      stack: samples.stack.map(oldStack => convertStack(oldStack)),
    });

    return Object.assign({}, thread, {
      samples: newSamples,
      stackTable: newStackTable,
    });
  });
}

/**
 * Given a thread with stacks like below, collapse together the platform stack frames into
 * a single pseudo platform stack frame. In the diagram "J" represents JavaScript stack
 * frame timing, and "P" Platform stack frame timing. New psuedo-stack frames are created
 * for the platform stacks.
 *
 * JJJJJJJJJJJJJJJJ  --->  JJJJJJJJJJJJJJJJ
 * PPPPPPPPPPPPPPPP        PPPPPPPPPPPPPPPP
 *     PPPPPPPPPPPP            JJJJJJJJ
 *     PPPPPPPP                JJJ  PPP
 *     JJJJJJJJ                     JJJ
 *     JJJ  PPP
 *          JJJ
 *
 * @param {Object} thread - A thread.
 * @returns {Object} The thread with collapsed samples.
 */
export function collapsePlatformStackFrames(thread: Thread): Thread {
  return timeCode('collapsePlatformStackFrames', () => {
    const { stackTable, funcTable, frameTable, samples, stringTable } = thread;

    // Create new tables for the data.
    const newStackTable: StackTable = {
      length: 0,
      frame: [],
      prefix: [],
    };
    const newFrameTable: FrameTable = {
      length: frameTable.length,
      implementation: frameTable.implementation.slice(),
      optimizations: frameTable.optimizations.slice(),
      line: frameTable.line.slice(),
      category: frameTable.category.slice(),
      func: frameTable.func.slice(),
      address: frameTable.address.slice(),
    };
    const newFuncTable: FuncTable = {
      length: funcTable.length,
      name: funcTable.name.slice(),
      resource: funcTable.resource.slice(),
      address: funcTable.address.slice(),
      isJS: funcTable.isJS.slice(),
      fileName: funcTable.fileName.slice(),
      lineNumber: funcTable.lineNumber.slice(),
    };

    // Create a Map that takes a prefix and frame as input, and maps it to the new stack
    // index. Since Maps can't be keyed off of two values, do a little math to key off
    // of both values: newStackPrefix * potentialFrameCount + frame => newStackIndex
    const prefixStackAndFrameToStack = new Map();
    const potentialFrameCount = newFrameTable.length * 2;
    const oldStackToNewStack = new Map();

    function convertStack(oldStack) {
      if (oldStack === null) {
        return null;
      }
      let newStack = oldStackToNewStack.get(oldStack);
      if (newStack === undefined) {
        // No stack was found, generate a new one.
        const oldStackPrefix = stackTable.prefix[oldStack];
        const newStackPrefix = convertStack(oldStackPrefix);
        const frameIndex = stackTable.frame[oldStack];
        const funcIndex = newFrameTable.func[frameIndex];
        const oldStackIsPlatform = !newFuncTable.isJS[funcIndex];
        let keepStackFrame = true;

        if (oldStackIsPlatform) {
          if (oldStackPrefix !== null) {
            // Only keep the platform stack frame if the prefix is JS.
            const prefixFrameIndex = stackTable.frame[oldStackPrefix];
            const prefixFuncIndex = newFrameTable.func[prefixFrameIndex];
            keepStackFrame = newFuncTable.isJS[prefixFuncIndex];
          }
        }

        if (keepStackFrame) {
          // Convert the old JS stack to a new JS stack.
          const prefixStackAndFrameIndex =
            (newStackPrefix === null ? -1 : newStackPrefix) *
              potentialFrameCount +
            frameIndex;
          newStack = prefixStackAndFrameToStack.get(prefixStackAndFrameIndex);
          if (newStack === undefined) {
            newStack = newStackTable.length++;
            newStackTable.prefix[newStack] = newStackPrefix;
            if (oldStackIsPlatform) {
              // Create a new platform frame
              const newFuncIndex = newFuncTable.length++;
              newFuncTable.name.push(stringTable.indexForString('Platform'));
              newFuncTable.resource.push(-1);
              newFuncTable.address.push(-1);
              newFuncTable.isJS.push(false);
              newFuncTable.fileName.push(null);
              newFuncTable.lineNumber.push(null);
              if (newFuncTable.name.length !== newFuncTable.length) {
                console.error(
                  'length is not correct',
                  newFuncTable.name.length,
                  newFuncTable.length
                );
              }

              newFrameTable.implementation.push(null);
              newFrameTable.optimizations.push(null);
              newFrameTable.line.push(null);
              newFrameTable.category.push(null);
              newFrameTable.func.push(newFuncIndex);
              newFrameTable.address.push(-1);

              newStackTable.frame[newStack] = newFrameTable.length++;
            } else {
              newStackTable.frame[newStack] = frameIndex;
            }
          }
          oldStackToNewStack.set(oldStack, newStack);
          prefixStackAndFrameToStack.set(prefixStackAndFrameIndex, newStack);
        }

        // If the the stack frame was not kept, use the prefix.
        if (newStack === undefined) {
          newStack = newStackPrefix;
        }
      }
      return newStack;
    }

    const newSamples = Object.assign({}, samples, {
      stack: samples.stack.map(oldStack => convertStack(oldStack)),
    });

    return Object.assign({}, thread, {
      samples: newSamples,
      stackTable: newStackTable,
      frameTable: newFrameTable,
      funcTable: newFuncTable,
    });
  });
}

export function filterThreadToSearchStrings(
  thread: Thread,
  searchStrings: string[] | null
): Thread {
  return timeCode('filterThreadToSearchStrings', () => {
    if (!searchStrings || !searchStrings.length) {
      return thread;
    }

    return searchStrings.reduce(filterThreadToSearchString, thread);
  });
}

export function filterThreadToSearchString(
  thread: Thread,
  searchString: string
): Thread {
  if (!searchString) {
    return thread;
  }
  const lowercaseSearchString = searchString.toLowerCase();
  const {
    samples,
    funcTable,
    frameTable,
    stackTable,
    stringTable,
    resourceTable,
  } = thread;

  function computeFuncMatchesFilter(func) {
    const nameIndex = funcTable.name[func];
    const nameString = stringTable.getString(nameIndex);
    if (nameString.toLowerCase().includes(lowercaseSearchString)) {
      return true;
    }

    const fileNameIndex = funcTable.fileName[func];
    if (fileNameIndex !== null) {
      const fileNameString = stringTable.getString(fileNameIndex);
      if (fileNameString.toLowerCase().includes(lowercaseSearchString)) {
        return true;
      }
    }

    const resourceIndex = funcTable.resource[func];
    const resourceNameIndex = resourceTable.name[resourceIndex];
    if (resourceNameIndex !== undefined) {
      const resourceNameString = stringTable.getString(resourceNameIndex);
      if (resourceNameString.toLowerCase().includes(lowercaseSearchString)) {
        return true;
      }
    }

    return false;
  }

  const funcMatchesFilterCache = new Map();
  function funcMatchesFilter(func) {
    let result = funcMatchesFilterCache.get(func);
    if (result === undefined) {
      result = computeFuncMatchesFilter(func);
      funcMatchesFilterCache.set(func, result);
    }
    return result;
  }

  const stackMatchesFilterCache = new Map();
  function stackMatchesFilter(stackIndex) {
    if (stackIndex === null) {
      return false;
    }
    let result = stackMatchesFilterCache.get(stackIndex);
    if (result === undefined) {
      const prefix = stackTable.prefix[stackIndex];
      if (stackMatchesFilter(prefix)) {
        result = true;
      } else {
        const frame = stackTable.frame[stackIndex];
        const func = frameTable.func[frame];
        result = funcMatchesFilter(func);
      }
      stackMatchesFilterCache.set(stackIndex, result);
    }
    return result;
  }

  return Object.assign({}, thread, {
    samples: Object.assign({}, samples, {
      stack: samples.stack.map(s => (stackMatchesFilter(s) ? s : null)),
    }),
  });
}

function _getSampleIndexRangeForSelection(
  samples: SamplesTable,
  rangeStart: number,
  rangeEnd: number
): [IndexIntoSamplesTable, IndexIntoSamplesTable] {
  // TODO: This should really use bisect. samples.time is sorted.
  const firstSample = samples.time.findIndex(t => t >= rangeStart);
  if (firstSample === -1) {
    return [samples.length, samples.length];
  }
  const afterLastSample = samples.time
    .slice(firstSample)
    .findIndex(t => t >= rangeEnd);
  if (afterLastSample === -1) {
    return [firstSample, samples.length];
  }
  return [firstSample, firstSample + afterLastSample];
}

function _getMarkerIndexRangeForSelection(
  markers: MarkersTable,
  rangeStart: number,
  rangeEnd: number
): [IndexIntoMarkersTable, IndexIntoMarkersTable] {
  // TODO: This should really use bisect. samples.time is sorted.
  const firstMarker = markers.time.findIndex(t => t >= rangeStart);
  if (firstMarker === -1) {
    return [markers.length, markers.length];
  }
  const afterLastSample = markers.time
    .slice(firstMarker)
    .findIndex(t => t >= rangeEnd);
  if (afterLastSample === -1) {
    return [firstMarker, markers.length];
  }
  return [firstMarker, firstMarker + afterLastSample];
}

export function filterThreadToRange(
  thread: Thread,
  rangeStart: number,
  rangeEnd: number
): Thread {
  const { samples, markers } = thread;
  const [sBegin, sEnd] = _getSampleIndexRangeForSelection(
    samples,
    rangeStart,
    rangeEnd
  );
  const newSamples = {
    length: sEnd - sBegin,
    time: samples.time.slice(sBegin, sEnd),
    stack: samples.stack.slice(sBegin, sEnd),
    responsiveness: samples.responsiveness.slice(sBegin, sEnd),
    rss: samples.rss.slice(sBegin, sEnd),
    uss: samples.uss.slice(sBegin, sEnd),
  };
  const [mBegin, mEnd] = _getMarkerIndexRangeForSelection(
    markers,
    rangeStart,
    rangeEnd
  );
  const newMarkers = {
    length: mEnd - mBegin,
    time: markers.time.slice(mBegin, mEnd),
    name: markers.name.slice(mBegin, mEnd),
    data: markers.data.slice(mBegin, mEnd),
  };
  return Object.assign({}, thread, {
    samples: newSamples,
    markers: newMarkers,
  });
}

// --------------- CallNodePath and CallNodeIndex manipulations ---------------

// Returns a list of CallNodeIndex from CallNodePaths. This function uses a map
// to speed up the look-up process.
export function getCallNodeIndicesFromPaths(
  callNodePaths: CallNodePath[],
  callNodeTable: CallNodeTable
): Array<IndexIntoCallNodeTable | null> {
  // This is a Map<CallNodePathHash, IndexIntoCallNodeTable>. This map speeds up
  // the look-up process by caching every CallNodePath we handle which avoids
  // looking up parents again and again.
  const cache = new Map();
  return callNodePaths.map(path =>
    _getCallNodeIndexFromPathWithCache(path, callNodeTable, cache)
  );
}

// Returns a CallNodeIndex from a CallNodePath, using and contributing to the
// cache parameter.
function _getCallNodeIndexFromPathWithCache(
  callNodePath: CallNodePath,
  callNodeTable: CallNodeTable,
  cache: Map<string, IndexIntoCallNodeTable>
): IndexIntoCallNodeTable | null {
  const hashFullPath = hashPath(callNodePath);
  const result = cache.get(hashFullPath);
  if (result !== undefined) {
    // The cache already has the result for the full path.
    return result;
  }

  // This array serves as a map and stores the hashes of callNodePath's
  // parents to speed up the algorithm. First we'll follow the tree from the
  // bottom towards the top, pushing hashes as we compute them, and then we'll
  // move back towards the bottom popping hashes from this array.
  const sliceHashes = [hashFullPath];

  // Step 1: find whether we already computed the index for one of the path's
  // parents, starting from the closest parent and looping towards the "top" of
  // the tree.
  // If we find it for one of the parents, we'll be able to start at this point
  // in the following look up.
  let i = callNodePath.length;
  let index;
  while (--i > 0) {
    // Looking up each parent for this call node, starting from the deepest node.
    // If we find a parent this makes it possible to start the look up from this location.
    const subPath = callNodePath.slice(0, i);
    const hash = hashPath(subPath);
    index = cache.get(hash);
    if (index !== undefined) {
      // Yay, we already have the result for a parent!
      break;
    }
    // Cache the hashed value because we'll need it later, after resolving this path.
    // Note we don't add the hash if we found the parent in the cache, so the
    // last added element here will accordingly be the first popped in the next
    // algorithm.
    sliceHashes.push(hash);
  }

  // Step 2: look for the requested path using the call node table, starting at
  // the parent we already know if we found one, and looping down the tree.
  // We're contributing to the cache at the same time.

  // `index` is undefined if no parent was found in the cache. In that case we
  // start from the start, and use `-1` which is the prefix we use to indicate
  // the root node.
  if (index === undefined) {
    index = -1;
  }

  while (i < callNodePath.length) {
    // Resolving the index for subpath `callNodePath.slice(0, i+1)` given we
    // know the index for the subpath `callNodePath.slice(0, i)` (its parent).
    const func = callNodePath[i];
    const nextNodeIndex = _getCallNodeIndexFromParentAndFunc(
      index,
      func,
      callNodeTable
    );

    // We couldn't find this path into the call node table. This shouldn't
    // normally happen.
    if (nextNodeIndex === null) {
      return null;
    }

    // Contributing to the shared cache
    const hash = sliceHashes.pop();
    cache.set(hash, nextNodeIndex);

    index = nextNodeIndex;
    i++;
  }

  return index < 0 ? null : index;
}

// Returns the CallNodeIndex that matches the function `func` and whose parent's
// CallNodeIndex is `parent`.
function _getCallNodeIndexFromParentAndFunc(
  parent: IndexIntoCallNodeTable,
  func: IndexIntoFuncTable,
  callNodeTable: CallNodeTable
): IndexIntoCallNodeTable | null {
  // Node children always come after their parents in the call node table,
  // that's why we start looping at `parent + 1`.
  // Note that because the root parent is `-1`, we correctly start at `0` when
  // we look for a top-level item.
  for (
    let callNodeIndex = parent + 1; // the root parent is -1
    callNodeIndex < callNodeTable.length;
    callNodeIndex++
  ) {
    if (
      callNodeTable.prefix[callNodeIndex] === parent &&
      callNodeTable.func[callNodeIndex] === func
    ) {
      return callNodeIndex;
    }
  }

  return null;
}

// This function returns a CallNodeIndex from a CallNodePath, using the
// specified `callNodeTable`.
export function getCallNodeIndexFromPath(
  callNodePath: CallNodePath,
  callNodeTable: CallNodeTable
): IndexIntoCallNodeTable | null {
  const [result] = getCallNodeIndicesFromPaths([callNodePath], callNodeTable);
  return result;
}

// This function returns a CallNodePath from a CallNodeIndex.
export function getCallNodePathFromIndex(
  callNodeIndex: IndexIntoCallNodeTable | null,
  callNodeTable: CallNodeTable
): CallNodePath {
  if (callNodeIndex === null) {
    return [];
  }
  if (callNodeIndex * 1 !== callNodeIndex) {
    console.log('bad callNodeIndex in getCallNodePath:', callNodeIndex);
    return [];
  }
  const callNodePath = [];
  let fs = callNodeIndex;
  while (fs !== -1) {
    callNodePath.push(callNodeTable.func[fs]);
    fs = callNodeTable.prefix[fs];
  }
  callNodePath.reverse();
  return callNodePath;
}

/**
 * This function converts a stack information into a call node path structure.
 */
export function convertStackToCallNodePath(
  thread: Thread,
  stack: IndexIntoStackTable
): CallNodePath {
  const { stackTable, frameTable } = thread;
  const path = [];
  for (
    let stackIndex = stack;
    stackIndex !== null;
    stackIndex = stackTable.prefix[stackIndex]
  ) {
    path.push(frameTable.func[stackTable.frame[stackIndex]]);
  }
  return path;
}

/**
 * Compute maximum depth of call stack for a given thread.
 *
 * Returns the depth of the deepest call node, but with a one-based
 * depth instead of a zero-based.
 *
 * If no samples are found, 0 is returned.
 */
export function computeCallNodeMaxDepth(
  thread: Thread,
  callNodeInfo: CallNodeInfo
): number {
  let maxDepth = 0;
  const { samples } = thread;
  const { callNodeTable, stackIndexToCallNodeIndex } = callNodeInfo;
  for (let i = 0; i < samples.length; i++) {
    const stackIndex = samples.stack[i];
    if (stackIndex !== null) {
      const callNodeIndex = stackIndexToCallNodeIndex[stackIndex];
      // Change to one-based depth
      const depth = callNodeTable.depth[callNodeIndex] + 1;
      if (depth > maxDepth) {
        maxDepth = depth;
      }
    }
  }
  return maxDepth;
}

export function invertCallstack(thread: Thread): Thread {
  return timeCode('invertCallstack', () => {
    const { stackTable, frameTable, samples } = thread;

    const newStackTable = {
      length: 0,
      frame: [],
      prefix: [],
    };
    // Create a Map that keys off of two values, both the prefix and frame combination
    // by using a bit of math: prefix * frameCount + frame => stackIndex
    const prefixAndFrameToStack = new Map();
    const frameCount = frameTable.length;

    function stackFor(prefix, frame) {
      const prefixAndFrameIndex =
        (prefix === null ? -1 : prefix) * frameCount + frame;
      let stackIndex = prefixAndFrameToStack.get(prefixAndFrameIndex);
      if (stackIndex === undefined) {
        stackIndex = newStackTable.length++;
        newStackTable.prefix[stackIndex] = prefix;
        newStackTable.frame[stackIndex] = frame;
        prefixAndFrameToStack.set(prefixAndFrameIndex, stackIndex);
      }
      return stackIndex;
    }

    const oldStackToNewStack = new Map();

    function convertStack(stackIndex) {
      if (stackIndex === null) {
        return null;
      }
      let newStack = oldStackToNewStack.get(stackIndex);
      if (newStack === undefined) {
        newStack = null;
        for (
          let currentStack = stackIndex;
          currentStack !== null;
          currentStack = stackTable.prefix[currentStack]
        ) {
          newStack = stackFor(newStack, stackTable.frame[currentStack]);
        }
        oldStackToNewStack.set(stackIndex, newStack);
      }
      return newStack;
    }

    const newSamples = Object.assign({}, samples, {
      stack: samples.stack.map(oldStack => convertStack(oldStack)),
    });

    return Object.assign({}, thread, {
      samples: newSamples,
      stackTable: newStackTable,
    });
  });
}

export function getSampleIndexClosestToTime(
  samples: SamplesTable,
  time: number,
  interval: number
): IndexIntoSamplesTable {
  // Bisect to find the index of the first sample after the provided time.
  const index = bisection.right(samples.time, time);

  if (index === 0) {
    return 0;
  }

  if (index === samples.length) {
    return samples.length - 1;
  }

  // Check the distance between the provided time and the center of the bisected sample
  // and its predecessor.
  const distanceToThis = samples.time[index] + interval / 2 - time;
  const distanceToLast = time - (samples.time[index - 1] + interval / 2);
  return distanceToThis < distanceToLast ? index : index - 1;
}

export function getJankInstances(
  samples: SamplesTable,
  thresholdInMs: number
): TracingMarker[] {
  const addTracingMarker = () =>
    jankInstances.push({
      start: lastTimestamp - lastResponsiveness,
      dur: lastResponsiveness,
      title: `${lastResponsiveness.toFixed(2)}ms event processing delay`,
      name: 'Jank',
      data: null,
    });

  let lastResponsiveness = 0;
  let lastTimestamp = 0;
  const jankInstances = [];
  for (let i = 0; i < samples.length; i++) {
    const currentResponsiveness = samples.responsiveness[i];
    if (currentResponsiveness < lastResponsiveness) {
      if (lastResponsiveness >= thresholdInMs) {
        addTracingMarker();
      }
    }
    lastResponsiveness = currentResponsiveness;
    lastTimestamp = samples.time[i];
  }
  if (lastResponsiveness >= thresholdInMs) {
    addTracingMarker();
  }
  return jankInstances;
}

export function getSearchFilteredMarkers(
  thread: Thread,
  searchString: string
): MarkersTable {
  if (!searchString) {
    return thread.markers;
  }
  const lowerCaseSearchString = searchString.toLowerCase();
  const { stringTable, markers } = thread;
  const newMarkersTable: MarkersTable = {
    data: [],
    name: [],
    time: [],
    length: 0,
  };
  function addMarker(markerIndex: IndexIntoMarkersTable) {
    newMarkersTable.data.push(markers.data[markerIndex]);
    newMarkersTable.time.push(markers.time[markerIndex]);
    newMarkersTable.name.push(markers.name[markerIndex]);
    newMarkersTable.length++;
  }
  for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
    const stringIndex = markers.name[markerIndex];
    const name = stringTable.getString(stringIndex);
    const lowerCaseName = name.toLowerCase();
    if (lowerCaseName.includes(lowerCaseSearchString)) {
      addMarker(markerIndex);
      continue;
    }
    const data = markers.data[markerIndex];
    if (data && typeof data === 'object') {
      if (
        typeof data.eventType === 'string' &&
        data.eventType.toLowerCase().includes(lowerCaseSearchString)
      ) {
        // Match DOMevents data.eventType
        addMarker(markerIndex);
        continue;
      }
      if (
        typeof data.name === 'string' &&
        data.name.toLowerCase().includes(lowerCaseSearchString)
      ) {
        // Match UserTiming's name.
        addMarker(markerIndex);
        continue;
      }
      if (
        typeof data.category === 'string' &&
        data.category.toLowerCase().includes(lowerCaseSearchString)
      ) {
        // Match UserTiming's name.
        addMarker(markerIndex);
        continue;
      }
    }
  }
  return newMarkersTable;
}

/**
 * This function takes a marker that packs in a marker payload into the string of the
 * name. This extracts that and turns it into a payload.
 */
export function extractMarkerDataFromName(thread: Thread): Thread {
  const { stringTable, markers } = thread;
  const newMarkers: MarkersTable = {
    data: markers.data.slice(),
    name: markers.name.slice(),
    time: markers.time.slice(),
    length: markers.length,
  };

  // Match: "Bailout_MonitorTypes after add on line 1013 of self-hosted:1008"
  // Match: "Bailout_TypeBarrierO at jumptarget on line 1490 of resource://devtools/shared/base-loader.js -> resource://devtools/client/shared/vendor/immutable.js:1484"
  const bailoutRegex =
    // Capture groups:
    //       type   afterAt    where        bailoutLine  script functionLine
    //        ↓     ↓          ↓                  ↓        ↓    ↓
    /^Bailout_(\w+) (after|at) ([\w _-]+) on line (\d+) of (.*):(\d+)$/;

  // Match: "Invalidate resource://devtools/shared/base-loader.js -> resource://devtools/client/shared/vendor/immutable.js:3662"
  // Match: "Invalidate self-hosted:4032"
  const invalidateRegex =
    // Capture groups:
    //         url    line
    //           ↓    ↓
    /^Invalidate (.*):(\d+)$/;

  const bailoutStringIndex = stringTable.indexForString('Bailout');
  const invalidationStringIndex = stringTable.indexForString('Invalidate');
  for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
    const nameIndex = markers.name[markerIndex];
    const time = markers.time[markerIndex];
    const name = stringTable.getString(nameIndex);
    let matchFound = false;
    if (name.startsWith('Bailout_')) {
      matchFound = true;
      const match = name.match(bailoutRegex);
      if (!match) {
        console.error(`Could not match regex for bailout: "${name}"`);
      } else {
        const [
          ,
          type,
          afterAt,
          where,
          bailoutLine,
          script,
          functionLine,
        ] = match;
        newMarkers.name[markerIndex] = bailoutStringIndex;
        newMarkers.data[markerIndex] = ({
          type: 'Bailout',
          bailoutType: type,
          where: afterAt + ' ' + where,
          script: script,
          bailoutLine: +bailoutLine,
          functionLine: +functionLine,
          startTime: time,
          endTime: time,
        }: BailoutPayload);
      }
    } else if (name.startsWith('Invalidate ')) {
      matchFound = true;
      const match = name.match(invalidateRegex);
      if (!match) {
        console.error(`Could not match regex for bailout: "${name}"`);
      } else {
        const [, url, line] = match;
        newMarkers.name[markerIndex] = invalidationStringIndex;
        newMarkers.data[markerIndex] = {
          type: 'Invalidation',
          url,
          line,
          startTime: time,
          endTime: time,
        };
      }
    }
    if (matchFound && markers.data[markerIndex]) {
      console.error(
        "A marker's payload was rewritten based off the text content of the marker. " +
          "perf.html assumed that the payload was empty, but it turns out it wasn't. " +
          'This is most likely an error and should be fixed. The marker name is:',
        name
      );
    }
  }

  return Object.assign({}, thread, { markers: newMarkers });
}

export function getTracingMarkers(thread: Thread): TracingMarker[] {
  const { stringTable, markers } = thread;
  const tracingMarkers: TracingMarker[] = [];
  // This map is used to track start and end markers for tracing markers.
  const openMarkers: Map<IndexIntoStringTable, TracingMarker[]> = new Map();
  for (let i = 0; i < markers.length; i++) {
    const data = markers.data[i];
    if (!data) {
      // Add a marker with a zero duration
      const marker = {
        start: markers.time[i],
        dur: 0,
        name: stringTable.getString(markers.name[i]),
        title: null,
        data: null,
      };
      tracingMarkers.push(marker);
    } else if (data.type === 'tracing') {
      // Tracing markers are created from two distinct markers that are created at
      // the start and end of whatever code that is running that we care about.
      // This is implemented by AutoProfilerTracing in Gecko.
      //
      // In this function we convert both of these raw markers into a single
      // tracing marker with a non-null duration.
      //
      // We also handle nested markers by assuming markers of the same type are
      // never interwoven: given input markers startA, startB, endC, endD, we'll
      // get 2 markers A-D and B-C.

      const time = markers.time[i];
      const nameStringIndex = markers.name[i];
      if (data.interval === 'start') {
        let markerBucket = openMarkers.get(nameStringIndex);
        if (markerBucket === undefined) {
          markerBucket = [];
          openMarkers.set(nameStringIndex, markerBucket);
        }

        markerBucket.push({
          start: time,
          name: stringTable.getString(nameStringIndex),
          dur: 0,
          title: null,
          data,
        });
      } else if (data.interval === 'end') {
        const markerBucket = openMarkers.get(nameStringIndex);
        let marker;
        if (markerBucket && markerBucket.length) {
          // We already encountered a matching "start" marker for this "end".
          marker = markerBucket.pop();
        } else {
          // No matching "start" marker has been encountered before this "end",
          // this means it was issued before the capture started. Here we create
          // a fake "start" marker to create the final tracing marker.
          // Note we won't have additional data (eg the cause stack) for this
          // marker because that data is contained in the "start" marker.

          const nameStringIndex = markers.name[i];

          marker = {
            start: -1, // Something negative so that we can distinguish it later
            name: stringTable.getString(nameStringIndex),
            dur: 0,
            title: null,
            data,
          };
        }
        if (marker.start !== undefined) {
          marker.dur = time - marker.start;
        }
        tracingMarkers.push(marker);
      }
    } else if ('startTime' in data && 'endTime' in data) {
      const { startTime, endTime } = data;
      if (typeof startTime === 'number' && typeof endTime === 'number') {
        const name = stringTable.getString(markers.name[i]);
        const duration = endTime - startTime;
        tracingMarkers.push({
          start: startTime,
          dur: duration,
          name,
          data,
          title: null,
        });
      }
    }
  }

  // Loop over tracing "start" markers without any "end" markers
  for (const markerBucket of openMarkers.values()) {
    for (const marker of markerBucket) {
      marker.dur = Infinity;
      tracingMarkers.push(marker);
    }
  }

  tracingMarkers.sort((a, b) => a.start - b.start);
  return tracingMarkers;
}

export function filterTracingMarkersToRange(
  tracingMarkers: TracingMarker[],
  rangeStart: number,
  rangeEnd: number
): TracingMarker[] {
  return tracingMarkers.filter(
    tm => tm.start < rangeEnd && tm.start + tm.dur >= rangeStart
  );
}

export function getFriendlyThreadName(
  threads: Thread[],
  thread: Thread
): string {
  let label;
  switch (thread.name) {
    case 'GeckoMain':
      switch (thread.processType) {
        case 'default':
          label = 'Main Thread';
          break;
        case 'tab': {
          const contentThreads = threads.filter(thread => {
            return thread.name === 'GeckoMain' && thread.processType === 'tab';
          });
          if (contentThreads.length > 1) {
            const index = 1 + contentThreads.indexOf(thread);
            label = `Content (${index} of ${contentThreads.length})`;
          } else {
            label = 'Content';
          }
          break;
        }
        case 'plugin':
          label = 'Plugin';
          break;
        default:
        // should we throw here ?
      }
      break;
    default:
  }

  if (!label) {
    label = thread.name;
  }
  return label;
}

export function getThreadProcessDetails(thread: Thread): string {
  let label = `thread: "${thread.name}"`;
  if (thread.tid !== undefined) {
    label += ` (${thread.tid})`;
  }

  if (thread.processType) {
    label += `\nprocess: "${thread.processType}"`;
    if (thread.pid !== undefined) {
      label += ` (${thread.pid})`;
    }
  }

  return label;
}

export function getEmptyProfile(): Profile {
  return {
    meta: {
      interval: 1,
      startTime: 0,
      abi: '',
      misc: '',
      oscpu: '',
      platform: '',
      processType: 0,
      extensions: emptyExtensions,
      product: 'Firefox',
      stackwalk: 0,
      toolkit: '',
      version: GECKO_PROFILE_VERSION,
      preprocessedProfileVersion: PROCESSED_PROFILE_VERSION,
    },
    threads: [],
  };
}

/**
 * This function returns the source origin for a function. This can be:
 * - a filename (javascript or object file)
 * - a URL (if the source is a website)
 */
export function getOriginAnnotationForFunc(
  funcIndex: IndexIntoFuncTable,
  funcTable: FuncTable,
  resourceTable: ResourceTable,
  stringTable: UniqueStringArray
): string {
  const resourceIndex = funcTable.resource[funcIndex];
  const resourceNameIndex = resourceTable.name[resourceIndex];

  let origin;
  if (resourceNameIndex !== undefined) {
    origin = stringTable.getString(resourceNameIndex);
  }

  const fileNameIndex = funcTable.fileName[funcIndex];
  let fileName;
  if (fileNameIndex !== null) {
    fileName = stringTable.getString(fileNameIndex);
    const lineNumber = funcTable.lineNumber[funcIndex];
    if (lineNumber !== null) {
      fileName += ':' + lineNumber;
    }
  }

  if (fileName) {
    // If the origin string is just a URL prefix that's part of the
    // filename, it doesn't add any useful information, so just return
    // the filename. If it's something else (e.g., an extension or
    // library name), prepend it to the filename.
    if (origin && !fileName.startsWith(origin)) {
      return `${origin}: ${fileName}`;
    }
    return fileName;
  }

  if (origin) {
    return origin;
  }

  return '';
}
