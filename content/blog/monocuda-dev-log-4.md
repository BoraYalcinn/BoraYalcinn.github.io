---
title: "MonoCUDA Dev Log #4"
date: 2026-10-06
draft: false
description: "Emissive materials, a BVH built in parallel on the GPU with Morton codes and Karras's radix tree, and a profiling session that found the real bottleneck was not the one I was looking for."
categories:
  - Dev
tags:
  - cuda
  - path-tracing
  - computer-graphics
  - graphics-programming
  - bvh
  - profiling
  - gpu
cover: /images/blog/render-v13.jpg
featured: true
---
Hi everyone, how have you been? I have been buried in school projects, so this
one took a while again. Forget that though, let's talk about what is in it.

Only two topics today, but one of them is by far the densest thing I have
written about in this series. Drum roll. Emissive materials, and BVHs, Bounding
Volume Hierarchies. And maybe a little profiling at the end, which turned out to
be the most surprising part of the whole week.

Here is where the last log left us:

![the render from the last log: a glass sphere, a fuzzy metal sphere and a red diffuse sphere on a green ground](/images/blog/render-v10.jpg)

## Emissive materials

Of all the materials I have written so far, emissive is the easy one. The first
question is what an emissive material even is, and the answer is almost
disappointing: it is a surface that is simply bright. It does not wait for light
to arrive, it produces its own. That is as close to a light source as this
renderer gets, and later the light structures will be built on top of exactly
this.

Every other material answers the question "where does this ray go next?". An
emissive one answers "stop, this is where the light came from". So there is no
scatter function to write. The bounce loop picks up the emitted colour and
breaks:

```cpp
sampleColor = sampleColor + attenuation * hit.mat.emittedColor;

if (hit.mat.type == MaterialType::Emissive) {
    break;
}
```

Two details in those three lines matter more than they look.

The emitted colour is multiplied by `attenuation`, not added raw. Attenuation is
everything the path has picked up on its way here, so a light seen directly is
full strength, and the same light seen after bouncing off a red wall arrives
tinted red and dimmer. That is colour bleeding, and it comes for free.

The second is that `sampleColor` now *accumulates* instead of being assigned.
Before this log the only light in the scene was the sky, which a path reached by
escaping, so one assignment at the end was enough. Now light can be found in the
middle of a path, and the sky itself became just another term:

```cpp
if (!hit.didHit) {
    sampleColor = sampleColor + attenuation * camera.backround_color;
    break;
}
```

The background is a camera parameter now, which is how the Cornell box at the
end of this post can have a pitch black background with a light inside it.

Making one is a single call:

```cpp
__host__ __device__ Material make_emissive(vec3 emittedColor) {
    return Material{MaterialType::Emissive, vec3(0,0,0), emittedColor, 0.f, 0.f};
}
```

Note the albedo is zero. An emissive surface in this renderer emits and does not
reflect. That is a simplification, and I wrote in the last log that emission and
reflectance should really be independent properties. The code allows it, since
`emittedColor` is a field every material has, but nothing in the scene uses both
yet.

To test it I put a bright sphere above the others, with an emitted colour well
above 1 because a light has to be brighter than the things it lights:

![the previous scene with a glowing white sphere above it, acting as a small sun](/images/blog/render-v11.jpg)

That sphere is the only reason the scene is lit any differently than before.
Good enough for now. On to the hard part.

## Bounding Volume Hierarchies

A path tracer spends almost all of its time answering one question: what does
this ray hit first? Up to now my answer was to test the ray against every object
in the scene. That costs O(N) per ray, and with 320,000 pixels, 50 samples each
and up to 20 bounces per sample, "per ray" means hundreds of millions of times.
Four spheres was fine. Anything interesting is not.

A **Bounding Volume Hierarchy** gets rid of most of those tests.

![a BVH over eight objects: each object in a small box, nearby boxes grouped into larger ones, and the binary tree that structure forms](/images/blog/classic-bvh.png)

Look at the figure. Each object gets wrapped in a small box. Nearby boxes are
grouped into a bigger box, those are grouped again, and so on until one box at
the top contains the whole scene. That nesting is a binary tree. Every leaf
holds an object and every internal node holds a box that encloses everything
below it.

The boxes are **AABBs**, Axis-Aligned Bounding Boxes, meaning their sides line up
with the x, y and z axes. That alignment is the whole point: testing a ray
against an arbitrarily oriented box is real work, while testing it against an
axis-aligned one is a handful of divisions and comparisons.

And here is the idea the whole structure exists for: **pruning**.

![the same tree with a ray through it: the left subtree is missed entirely and crossed out, and only the nodes along the ray's path are visited](/images/blog/bvh-pruning.png)

Start at the root and test the ray against its box. If the ray misses a box, it
cannot possibly hit anything inside that box, so the entire subtree underneath
is skipped with that one test. In the figure the left half of the scene is
discarded immediately, and with it four of the eight objects. What is left is a
walk down a few branches, which is roughly O(log N) instead of O(N).

Worth saying clearly: a BVH never changes the scene. Objects can overlap, and so
can the boxes of sibling nodes. It is purely an acceleration structure, a
decision about which intersection tests are safe to skip.

### Building it in parallel is a different problem

Here is where this project differs from the version of this you would write on a
CPU. This is a parallel computing project. A structure that is quick to traverse
but can only be built one node at a time is only half an answer.

My own first idea was this: threads are good at splitting a loop into pieces, so
why not build a separate tree-like structure for each dimension, one for x, one
for y, one for z, and let them build at the same time? When I went looking for
whether this was a known thing, it turned out the closest relative is the **k-d
tree**, a single tree whose levels alternate the splitting axis: x, then y, then
z, then x again.

K-d trees are good structures. They also have problems that matter here:

- **Objects straddle the split planes.** A k-d tree splits *space*, not objects.
  An object crossing a plane has to be referenced on both sides, or clipped, so
  memory use becomes unpredictable and the same object can get tested more than
  once.
- **Construction is sequential by nature.** Each split depends on the one above
  it, so the top of the tree, where the most work is, has the least parallelism.
  Exactly backwards from what a GPU wants. Good SAH builders are complicated on
  top of that.
- **Moving objects mean rebuilding**, which is painful when a rebuild is slow.

Then I found Tero Karras's paper and his blog series on NVIDIA's site, and the
answer there is much better than mine.

### Morton codes

Instead of three trees, one per axis, take all three coordinates and fold them
into a single number.

![a 3D position turned into one integer by quantizing each axis and interleaving the bits, with the Z-order curve it traces through a grid](/images/blog/morton-code.png)

Quantize each coordinate to a fixed number of bits, then interleave those bits:
one bit from x, one from y, one from z, repeating. The result is a **Morton
code**, and the order it puts points in is called the Z-order curve, after G. M.
Morton who described it in 1966.

The property that makes it useful is in the top right of the figure. Points that
are close together in 3D tend to get Morton codes that are close together as
numbers. So a three dimensional spatial problem turns into sorting a list of
integers, and sorting integers is something GPUs are extremely good at.

My version uses 10 bits per axis, which gives a 30-bit code:

```cpp
__host__ __device__ inline unsigned int expandBits(const unsigned int point){
    unsigned int expandedPoint = 0;
    for (int i = 0; i < 10; i++){
        unsigned int bit = (point >> i) & 1;
        expandedPoint |= (bit << (3 * i));     // leave two gaps after every bit
    }
    return expandedPoint;
}

__host__ __device__ inline unsigned int quantize(float value, float minVal, float maxVal){
    float normalized = (value - minVal) / (maxVal - minVal);
    return (unsigned int)(normalized * 1023.0f);     // 10 bits
}

__host__ __device__ inline unsigned int morton3D(const vec3& centroid, const AABB& sceneBounds){
    unsigned int clampedX = quantize(centroid.x, sceneBounds.minInterval.x, sceneBounds.maxInterval.x);
    unsigned int clampedY = quantize(centroid.y, sceneBounds.minInterval.y, sceneBounds.maxInterval.y);
    unsigned int clampedZ = quantize(centroid.z, sceneBounds.minInterval.z, sceneBounds.maxInterval.z);

    clampedX = expandBits(clampedX);
    clampedY = expandBits(clampedY);
    clampedZ = expandBits(clampedZ);

    return clampedX | clampedY << 1 | clampedZ << 2;
}
```

`expandBits` spreads a 10-bit number out so each of its bits has two empty slots
after it, and then the three shifted copies slot into each other like a zip.

### What Karras added

Morton codes in a BVH builder were not new. Lauterbach and others used them in
2009 for what they called an LBVH, a Linear BVH, but that construction still
walked the tree level by level.

Karras's contribution, published at HPG 2012 and written up as the "Thinking
Parallel" series on NVIDIA's developer blog, is the part that makes it fully
parallel: once the primitives are sorted by Morton code, **the sorted array
already contains the tree**. Every internal node can work out which slice of the
array it owns and where that slice splits, by itself, without waiting for its
parent or its children. So all n-1 internal nodes can be built at the same time
by n-1 threads.

![the sorted Morton codes as leaves, with each internal node covering a range of the array and splitting it where the codes first differ](/images/blog/karras-bvh.png)

The recipe is four steps:

1. Turn each primitive's centroid into a Morton code.
2. Sort the primitives by that code.
3. One thread per internal node: use the shared bit prefixes of neighbouring
   codes to find the range this node covers and where it splits.
4. Walk up from the leaves computing bounding boxes.

### How it looks in my code

**Leaves** are the easy kernel. One thread per primitive, in sorted order:

```cpp
__global__ void buildLeavesKernel(BVH_Node* d_leafNode, const int* sortedPrimitiveIDs,
                                  const AABB* sortedBounds, int numObjects){
    int idx = threadIdx.x + blockIdx.x * blockDim.x;
    if (idx >= numObjects) return;
    d_leafNode[idx].primitiveIndex = sortedPrimitiveIDs[idx];
    d_leafNode[idx].bounds = sortedBounds[idx];
    d_leafNode[idx].isLeaf = true;
}
```

**Internal nodes** are where the trick lives. The key function is `delta`, which
answers "how many leading bits do these two Morton codes share?" with a single
instruction, `__clz`, count leading zeros, applied to their XOR:

```cpp
__device__ inline int delta(const unsigned int* sortedMortonCodes, int numObjects, int i, int j){
    if (j < 0 || j >= numObjects) return -1;

    unsigned int codeI = sortedMortonCodes[i];
    unsigned int codeJ = sortedMortonCodes[j];

    if (codeI == codeJ){
        return 32 + __clz((unsigned int)(i ^ j));   // duplicate codes: fall back to the index
    }
    return __clz(codeI ^ codeJ);
}
```

A longer shared prefix means the two primitives are closer together in space.
`determineRange` uses that to grow outward from the node's own index until the
prefix stops being long enough, which gives the slice of the array the node
owns, and `findSplit` binary searches inside that slice for the point where the
highest differing bit changes. That point is the boundary between the two
children. Each child is either a leaf, if it is a single primitive, or another
internal node.

The duplicate-code case in `delta` is not a detail you can skip. Two primitives
whose centroids quantize to the same 30-bit code would otherwise make the range
search run forever, so the index itself is used as a tiebreaker.

**Bounds** are the only part that cannot be done independently, since a node's
box depends on its children's boxes. The trick is to start from the leaves and
let an atomic counter decide who does the work:

```cpp
__global__ void refitBoundsKernel(BVH_Node* d_internalNodes, BVH_Node* d_leafNode,
                                  int* d_atomicCounters, int numObjects){
    int idx = threadIdx.x + blockIdx.x * blockDim.x;
    if (idx >= numObjects) return;

    int currentParent = d_leafNode[idx].parent;

    while (currentParent != -1) {
        int old = atomicAdd(&d_atomicCounters[currentParent], 1);
        if (old == 0) return;        // first child here: stop, the sibling will finish this node

        BVH_Node& node = d_internalNodes[currentParent];
        AABB leftBounds  = node.leftIsLeaf  ? d_leafNode[node.leftChild].bounds
                                            : d_internalNodes[node.leftChild].bounds;
        AABB rightBounds = node.rightIsLeaf ? d_leafNode[node.rightChild].bounds
                                            : d_internalNodes[node.rightChild].bounds;
        node.bounds = merge(leftBounds, rightBounds);

        currentParent = node.parent;
    }
}
```

Every thread starts at a leaf and climbs toward the root. At each node it bumps
a counter. The thread that finds the counter at zero is the first of the two
children to arrive, and it quits. The second one knows both children are ready,
merges the boxes, and keeps climbing. No barriers, no level-by-level passes, and
no node is ever computed before its children exist. This is my favourite piece
of code in the whole project.

**Traversal** is iterative with an explicit stack, because recursion on a GPU is
a good way to run out of stack:

```cpp
const int MAX_STACK = 64;
int stackIdx[MAX_STACK];
bool stackIsLeaf[MAX_STACK];
```

At each node both children's boxes get the slab test, `hit_aabb`. A child that
is a leaf and overlaps goes straight to the primitive test. A child that is an
internal node and overlaps gets pushed on the stack. Anything that misses is
dropped, and that drop is the pruning the whole structure is for. One extra
detail: the far distance passed to the box test is the closest hit found so far,
so once the ray has hit something, boxes behind that hit stop being considered.

### How this differs from a classic BVH

| | Classic BVH (top-down SAH) | Mine (LBVH, Karras) |
|---|---|---|
| Split choice | Surface Area Heuristic, evaluates candidate splits by cost | Wherever the Morton codes first differ |
| Build parallelism | Top of the tree is nearly sequential | All n-1 internal nodes at once |
| Tree quality | Better, fewer wasted traversal steps | Worse, the split ignores geometry size |
| Build speed | Slow | Fast, which is the entire point |
| Leaf size | Several primitives per leaf, tuned | Exactly one primitive per leaf |
| Traversal | Same idea, stack-based | Same idea, stack-based |
| Moving objects | Rebuild is expensive | Rebuild is cheap enough to do per frame |

The short version: a SAH tree is a better tree, and an LBVH is a tree you can
build in microseconds on hardware that has thousands of threads sitting idle.
For a renderer that will eventually want to rebuild per frame, that is the right
trade.

One honest note about my implementation. The construction kernels run on the
GPU, but the sort before them is still `std::sort` on the host, and the Morton
codes are computed there too. The parallel part is the part Karras's paper is
about, and the sort is the obvious next thing to move across.

Here is the test scene I built to put it under some load, a few hundred spheres
instead of four:

![a field of small coloured spheres with a glass and a metal sphere among them, lit by a glowing sphere above](/images/blog/render-v12.jpg)

## A little profiling

So the BVH was in, and the renderer got faster. Not as much faster as I
expected, which bothered me enough to go looking. If a structure that is
supposed to turn O(N) into O(log N) does not pay off, something else is eating
the time.

This is the part of the log I did not plan to write and ended up enjoying most.

### First, the terminal

I profiled the release build with `ncu`, NVIDIA's Nsight Compute, and read the
summary sections it prints. The ones I looked at:

- **Duration**: how long the kernel actually took. 6.84 ms per
  `trace_sample_kernel` launch. This is the number that matters. Any change that
  does not move it did not help, no matter what the other metrics say.
- **Speed of Light**: how close the kernel is to the hardware's peak compute and
  memory throughput. Mine showed L1/TEX at about 98% and DRAM at about 0.2%. So
  the kernel was extremely busy with cache traffic and barely touching main
  memory. Busy, but the report does not say with what.
- **Occupancy**: how many warps are resident per multiprocessor against the
  maximum. 50% theoretical, 41.7% achieved, limited by registers, 80 per thread.
- **Local memory traffic**: where the compiler puts per-thread arrays it cannot
  keep in registers. My traversal stack lives there, so it was my first suspect.
  I shrank the stack from 64 entries to 32 and measured again. Nothing. Not a
  millisecond.

The one real thing I found at this stage was not in the report, it was next to
it. The release binary was being JIT-compiled from PTX at startup rather than
running native machine code, because `CMAKE_CUDA_ARCHITECTURES` was being set
*after* the `project()` call in my CMakeLists, by which point CMake had already
filled it with nvcc's default of sm_75. My GPU is sm_120. Moving three lines
above `project()` fixed it. It also did not move the duration measurably, but at
least the thing I was profiling was finally the thing that runs.

So the terminal told me the kernel was heavy and not where. Some of its hints,
the "estimated speedup" numbers in particular, pointed me somewhere else
entirely. Time for the GUI.

### Then, Nsight

I rebuilt with `-lineinfo`, which keeps enough debug information for the
profiler to map machine instructions back to source lines, and opened the Source
page in Nsight Compute. And there it was, immediately.

A short explanation of what I was looking at. GPU threads run in groups of 32
called warps. A warp is **stalled** when it is ready to run but cannot issue its
next instruction, usually because it is waiting on memory or on a previous
result. Nsight samples the warps while the kernel runs and records which source
line each stalled warp was sitting on. A line that collects a large share of
those samples is where your kernel actually spends its life.

In my profile, **86.64% of the stall samples were on a single line**, and that
line was not in my code. It was inside cuRAND's own header, `curand_kernel.h`.

<!-- GÖRSEL: Nsight Source sayfası, curand_kernel.h'deki satırın stall örneklerini topladığı ekran görüntüsü. Dosya henüz sitede yok. -->

Random numbers on a GPU do not work like `rand()` does on a CPU. Every thread
needs its own generator state, and setting that state up with `curand_init` is
expensive, because it has to skip ahead in the random sequence far enough that
this thread's stream does not overlap anybody else's. For XORWOW, that skipahead
is matrix work.

And I was doing it on every sample, for every pixel:

```cpp
curandState rngState;
curand_init(seed, pixel_index, sampleIndex, &rngState);   // every sample, every pixel
```

320,000 pixels times 50 samples is about 16 million initializations per render,
each one skipping ahead through a sequence, to produce a handful of random
numbers and then be thrown away. The BVH was not the bottleneck. The random
number generator setup was, and it had been there since long before the BVH
existed.

The fix is to initialize once per pixel and keep the state:

```cpp
__global__ void init_rng_kernel(curandState* rngStates, int maximumX, int maximumY,
                                unsigned long long seed){
    int i = threadIdx.x + blockIdx.x * blockDim.x;
    int j = threadIdx.y + blockIdx.y * blockDim.y;
    if (i >= maximumX || j >= maximumY) return;
    int pixel_index = maximumX * j + i;
    curand_init(seed, pixel_index, 0, &rngStates[pixel_index]);
}
```

and then the trace kernel loads its state at the start and writes it back at the
end, so each pixel carries on its own stream across samples instead of starting
a new one:

```cpp
curandState rngState = rngStates[pixel_index];
// ... trace the sample ...
rngStates[pixel_index] = rngState;
```

<!-- GÖRSEL: düzeltmeden sonraki Nsight ekran görüntüsü, stall'ların dağılmış hali. Dosya henüz sitede yok. -->

**6.84 ms down to 1.49 ms per sample.** About 4.6 times faster, from deleting one
line and adding a kernel that runs once.

It is not free. The states live in global memory now, 320,000 of them at 48
bytes each, so about 15 MB, and registers per thread went from 80 to 90, which
costs a little occupancy. For a 4.6x speedup I will take that trade every time.

The lesson I am taking from this: I assumed the slow part was the part I had
just written, because that is the part I was thinking about. The profiler did
not care what I was thinking about.

## And the final render

Let's finish with something nice. Drum roll please, because yes, it is a Cornell
box, and I love this scene.

![a Cornell box: red and green walls, a light in the ceiling, a tall box, a mirror sphere and a floor covered in small coloured spheres](/images/blog/render-v13.jpg)

Everything in this post is in that image. The walls, the ceiling light and the
box are triangles, two per quad. The big sphere is a mirror with a touch of
fuzz, the small ones are a mix of diffuse, metal and glass. The light is an
emissive quad in the ceiling, and the background colour is black, so every
photon in there came out of that panel. Count the spheres and remember that the
old renderer tested every ray against every one of them.

Look at the colour on the walls of the mirror sphere's reflection, and the red
and green bleeding onto the white box and the floor. Nobody wrote a line of code
for that. It is just paths bouncing.

This week was dense, I learned a lot, and I hope I managed to pass some of the
way I think about it along, and maybe even taught a couple of things.

See you in the next one. I am not promising it will be about MonoCUDA, but it
probably will be, unless I decide to write about something else. Either way,
have a good one, and please check the references and sources in the repo's
README for the papers and posts I leaned on here.
