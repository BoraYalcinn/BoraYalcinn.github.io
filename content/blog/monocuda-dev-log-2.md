---
title: "MonoCUDA Dev Log #2"
date: 2026-09-21
draft: false
description: "A thin lens instead of a pinhole, a floor made out of an enormous sphere, Lambertian diffuse bounces, Russian roulette, and why splitting the render kernel in two made nothing faster."
categories:
  - Dev
tags:
  - cuda
  - path-tracing
  - computer-graphics
  - graphics-programming
  - monte-carlo
  - gpu
cover: /images/blog/render-v5.jpg
featured: true
---
Hi everyone, welcome to the second dev log for **MonoCUDA**, my single-file CUDA
path tracer. Last time we covered the essentials: the CUDA side of things, ray
intersection against spheres and triangles, and a camera to fire rays through.
This time I went deeper: a real lens, actual light transport, and a couple of
things that broke or turned out not to do what I expected. Let's get started.

Here's where last week left off, with a sphere and a triangle floating in
nothing, coloured by their surface normals:

![last week's render: normal-coloured shapes on a sky gradient](/images/blog/renderv2.jpg)

## From a pinhole to a thin lens

Before fixing anything that's visibly wrong with that image, I wanted to deal
with something that isn't wrong so much as unrealistic: the camera. What we had
was a **pinhole** camera, where every ray leaves from a single mathematical
point. In the real world nothing is that simple, and I say that as someone who
spends a fair amount of time behind an actual camera, since photography is my
other hobby.

A real lens has an **aperture**: an opening with actual area, which lets light
in across its whole surface rather than through an infinitely small hole. That
one difference is what gives you depth of field. Instead of every point in the
scene being rendered perfectly sharp, only what sits at the **focus distance**
is sharp, and everything nearer or farther falls off into blur.

The trick to putting that in a ray tracer is smaller than it sounds. The ray's
*target* doesn't change; it's still the same point on the focus plane for a
given pixel. What changes is where the ray *starts*: instead of the camera
centre, it starts at a random point on a disk of radius `aperture / 2`.

![thin lens geometry: film, the aperture disk and the focus plane, with the formulas for the ray's origin on the lens](/images/blog/thin-lens.png)

Look at what that does. Every lens sample for a given pixel is aimed at the same
point on the focus plane, so anything *at* that distance gets hit in the same
place by all of them, so it stays sharp. A surface nearer or farther than the
focus plane gets hit at a *different* point by each lens sample, and averaging
those samples together is exactly what produces the blur. Depth of field falls
out of the geometry; there's no blur filter anywhere.

Picking the random point is the same rejection sampling I used before: throw a
point into a square, keep it if it landed inside the circle, otherwise throw
again.

```cpp
__device__ vec3 random_in_unit_disk(curandState* rngState) const {
    while (true) {
        float randomX = curand_uniform(rngState) * 2.f - 1.f;
        float randomY = curand_uniform(rngState) * 2.f - 1.f;
        vec3 candidatePoint = vec3(randomX, randomY, 0.0f);
        if (candidatePoint.length_squared() < 1.0f) {
            return candidatePoint;
        }
    }
}

__device__ Ray getRay(int pixelX, int pixelY, curandState* rngState) const {
    vec3 pixelCenter = pixel00_location + (pixel_delta_u * float(pixelX))
                                        + (pixel_delta_v * float(pixelY));

    vec3 randomPointOnLens = random_in_unit_disk(rngState) * lens_radius;
    vec3 lensOffSetInWorldSpace = u * randomPointOnLens.x + v * randomPointOnLens.y;
    vec3 rayOriginOnLens = center + lensOffSetInWorldSpace;

    vec3 rayDirection = (pixelCenter - rayOriginOnLens).normalize();
    return Ray(rayOriginOnLens, rayDirection);
}
```

### The constructor that kept biting me

A confession, since these logs are as much about what goes wrong as what works.
I kept trying to give `Camera` a long parameterised constructor,
`Camera(aspect_ratio_, image_width_, vfov_, look_from_, ...)`, and I kept
getting it wrong. Arguments in the wrong order. An `image_width(image_width)`
initialiser quietly initialising a member from itself. Parameters that simply
never made it to the member they were named after.

None of those are hard bugs individually; together they wasted a real amount of
time, and every one of them was a *silent* failure: the render just came out
subtly wrong. So I gave up on the clever constructor and went with an empty one,
public fields set individually, and an `initialize()` call afterwards:

```cpp
Camera cam;
cam.aspect_ratio = numberOfPixels_X / float(numberOfPixels_Y);
cam.image_width  = numberOfPixels_X;
cam.samples_per_pixel = 50;
cam.max_depth    = 20;
cam.vfov         = 90.0f;
cam.look_from    = vec3(0, 1, 2);
cam.look_at      = vec3(0, 0, 0);
cam.aperture     = 0.1f;
cam.focus_distance = 3.5f;
cam.initialize();
```

It's more lines, and I don't care. You can't get the order wrong when there is
no order, and the call site tells you what every value means.

There was a related bug worth mentioning, because it's a classic: `lens_radius`
started life as a member with a default initialiser, `float lens_radius =
aperture / 2.;`. That reads `aperture` before anything has set it. Member
initialisers run in declaration order, at construction time, long before
`cam.aperture = 0.1f` ever happens. The fix was to move the computation into
`initialize()`, where the inputs are guaranteed to be there.

## Giving the scene a floor

Now for what's actually wrong with the image. The first thing I see is shapes
floating in a void. They need something to sit on, and the trick for that is so
cheap it feels like cheating: add an **enormous sphere** underneath everything,
make it green, and call it grass.

```cpp
scene.spheres.push_back(sphere(vec3(0, -100.5f, -1), 100.0f, vec3(0.5f, 1.0f, 0.5f)));
```

A sphere with a radius of 100 sitting just below the scene is, as far as any ray
that hits it is concerned, a gently curved ground plane. No new primitive type,
no plane intersection routine, no extra code in the hit loop; the sphere
intersection I already had does all of it. You can even see the curvature in the
horizon, which I actually like; it reads like a small planet.

![the same shapes standing on a giant green sphere acting as a floor](/images/blog/render-v3.jpg)

## Those jagged edges

Better. Now look at the edges of the triangle and the spheres: hard little
staircases. In graphics the fix for this goes by the name **antialiasing**, and
understanding why the staircase is there at all tells you what the fix has to
be.

A pixel isn't a point. It's a small square of the image with area, and the true
colour of that pixel is the *average* of everything visible across that square.
When a shape's edge cuts through the middle of a pixel, the honest answer is
"about 60% orange, 40% sky". But if you fire a single ray through the exact
centre of the pixel, you get one answer or the other: fully orange or fully sky,
nothing in between. Every edge in the image gets quantised to whole pixels, and
that's the staircase.

![one centre sample landing entirely on one side of an edge, versus nine jittered samples splitting it in the true ratio](/images/blog/antialiasing.png)

The fix is to take many samples per pixel at slightly different positions and
average them. That's the same Monte Carlo integration the rest of the renderer
runs on, applied to the pixel's own coverage: more samples, less error, with the
usual 1/√N convergence, so going from 1 sample to 9 roughly cuts the noise by
three, not by nine.

The offsets in that figure, a random ε in [-0.5, 0.5] on each axis scaled by
`pixel_delta_u` and `pixel_delta_v`, are exactly what the code needs to do. And
here's a detail I only noticed while writing this up, which is worth being
precise about: my current `getRay()` doesn't do it yet. It still aims at the
exact pixel centre. The edges in the render below are smooth anyway, and the
reason is the lens: with `aperture = 0.1` every sample starts from a different
point on the lens disk, so each one traces a slightly different path through the
pixel and the 50 samples average out. That's antialiasing as a side effect of
depth of field, which works here but is not the same thing as sampling the pixel
properly: set the aperture to zero and the staircases come straight back. Adding
an explicit jitter inside `getRay()` is a five-line change and it's the next
thing on my list.

![edges smoothed out by averaging 50 samples per pixel](/images/blog/render-v4.jpg)

## Colour, attenuation, and what a path tracer is actually doing

So far every surface has been a flat colour. Let's talk about what colour even
means in a renderer like this, because it's the heart of the whole thing.

When light hits a red surface, the surface absorbs most of the green and blue
and reflects most of the red, which is *why* it looks red. A ray bouncing around
a scene is doing the same accounting in reverse: every time it hits something,
it picks up that surface's **albedo** and carries a bit less light onward. We
track that with a running multiplier called **attenuation**, starting at `(1, 1,
1)` and getting multiplied by the albedo at every bounce.

![attenuation chain: a camera ray bouncing off a red then a yellow surface, each albedo multiplied in, before escaping to the sky](/images/blog/attenuation-chain.png)

A path only contributes colour when it eventually *escapes* and hits the sky,
which is my only light source at the moment. At that point the sky colour gets
multiplied by everything the path accumulated on the way:

```cpp
vec3 attenuation(1.0f, 1.0f, 1.0f);
vec3 sampleColor(0.0f, 0.0f, 0.0f);

for (int depth = 0; depth < camera.max_depth; depth++) {
    hitRecord hit = find_nearest_hit(r.origin, r.direction, /* ... */);

    if (!hit.didHit) {                      // escaped: the sky lights this path
        vec3 unitDir = r.direction.normalize();
        float t = 0.5f * (unitDir.y + 1.0f);
        vec3 skyColor = vec3(1.0f, 1.0f, 1.0f) * (1.0f - t)
                      + vec3(0.5f, 0.7f, 1.0f) * t;
        sampleColor = attenuation * skyColor;
        break;
    }

    attenuation = attenuation * hit.albedo; // one more surface, a little less light
    vec3 newDirection = lambertian_scatter_direction(hit.hitNormal, &rngState);
    r = Ray(hit.hitPoint, newDirection);
}
```

A path that never escapes contributes black. That's not a failure case; it's the
renderer telling you that light never reached that point, which is what a shadow
*is*. Nobody wrote a shadow algorithm; shadows are what you get when paths fail
to find the light.

## Lambertian diffuse

Now, how should a ray bounce off a matte surface? The model I knew coming in was
the ambient/diffuse/specular one from game-math books: Blinn-Phong, local
illumination. That model computes a colour at a point from light positions
directly, and it has a hand-tuned "ambient" term whose entire job is to fake the
light that would have arrived by bouncing off everything else in the room.

A path tracer doesn't need that fake, because it actually traces those bounces.
This is the difference between local and **global illumination**, and it's why
there's no ambient constant anywhere in my code: the bounce loop *is* the
ambient term. It also means I'm doing Monte Carlo path tracing rather than
Whitted-style ray tracing, which is what modern production renderers do.

For a matte (Lambertian) surface, the classic way to pick the bounce direction
is beautifully simple: take the surface normal, add a random unit vector to it,
and normalise.

```cpp
__device__ vec3 random_unit_vector(curandState* rngState) {
    while (true) {                                   // rejection sampling in a cube
        float x = curand_uniform(rngState) * 2.f - 1.f;
        float y = curand_uniform(rngState) * 2.f - 1.f;
        float z = curand_uniform(rngState) * 2.f - 1.f;
        vec3 randomVec(x, y, z);
        if (randomVec.length_squared() < 1.0f) {     // keep only what's inside the sphere
            return randomVec.normalize();
        }
    }
}

__device__ vec3 lambertian_scatter_direction(const vec3& surfaceNormal,
                                             curandState* rngState) {
    vec3 randomDirection = surfaceNormal + random_unit_vector(rngState);

    if (randomDirection.length_squared() < 1e-8f) {  // degenerate: exactly opposite
        return surfaceNormal;
    }
    return randomDirection.normalize();
}
```

Geometrically, adding a random unit vector to the normal is the same as picking
a point on a unit sphere that sits tangent to the surface. Directions close to
the normal come up more often than directions near the horizon. The distribution
is **cosine-weighted**, without a single trigonometric function being called.

![diffuse reflection off a Lambertian surface: the cosine-shaped lobe of scatter directions, the BRDF, and the estimator collapsing to albedo](/images/blog/lambertian-scatter.png)

And here's the part that made everything click for me. The Monte Carlo estimator
for one bounce is the BRDF times the cosine term, divided by the probability of
having picked that direction:

$$\text{estimate} = \frac{f(\omega') \cdot \cos\theta}{p(\omega')}$$

For a Lambertian surface the BRDF is constant, $$f(\omega') =
\frac{\text{albedo}}{\pi}$$

and cosine-weighted sampling means the probability of a direction is

$$p(\omega') = \frac{\cos\theta}{\pi}$$

Put them together and everything cancels:

$$\frac{\frac{\text{albedo}}{\pi} \cdot \cos\theta}{\frac{\cos\theta}{\pi}} = \text{albedo}$$

That's why the code contains no cosine term and no π anywhere; it just
multiplies by the albedo. It looks like a shortcut and it isn't; it's the full
estimator after the sampling strategy has cancelled two thirds of it. Choosing
the right distribution to sample from didn't just reduce the noise, it deleted
the maths.

Here's the same scene with diffuse bouncing, 50 samples per pixel, 20 bounces
deep:

![diffuse render: soft shading and contact shadows, with visible Monte Carlo noise](/images/blog/render-v5.jpg)

Softly shaded surfaces, darkening where the spheres meet the ground, colour
bleeding from the grass onto the shapes, none of which is explicitly coded
anywhere. And it's noisy, because 50 samples is not many when each one is a
random walk. Noise is the currency Monte Carlo trades in.

## Russian roulette

Twenty bounces per path is a lot when most paths have stopped mattering long
before that. After a few bounces the attenuation has usually shrunk to something
tiny, and the path is spending full GPU time to contribute almost nothing.

The obvious fix, "stop after N bounces" or "stop when attenuation is small", is
*biased*: you're systematically throwing away energy, and the image comes out
darker than the truth. **Russian roulette** is the unbiased version. Past a
certain depth you kill the path with probability `1 - p`, and if it survives you
divide its attenuation by `p` to compensate.

![russian roulette: the two branches of the estimator and the expectation showing the compensation keeps it unbiased](/images/blog/russian-roulette.png)

Why that stays honest is a one-line proof. A path carrying colour `C` either
dies and contributes nothing, or survives with probability `p` carrying `C / p`:

$$E[\text{estimate}] = (1 - p) \cdot 0 + p \cdot \frac{C}{p} = C$$

The expected value is unchanged. Individual paths get noisier, since some now
count for more than they should and some for nothing, but the average lands in
the same place, and it gets there having traced far fewer bounces.

```cpp
if (depth > 3) {
    float maxComponent = fmaxf(attenuation.x, fmaxf(attenuation.y, attenuation.z));
    float continueProbability = fminf(maxComponent, 0.95f);
    if (curand_uniform(&rngState) > continueProbability) break;

    attenuation = attenuation / continueProbability;   // compensate the survivors
}
```

Now the honest part: **on this scene it does essentially nothing.** My test scene
is a handful of shapes under an open sky, so rays escape into the sky within one
to three bounces almost every time, and the `depth > 3` branch barely ever runs.
I measured no speedup at all. I kept the code because the moment the scene has
enclosed geometry (walls, a ceiling, a Cornell-box kind of setup where paths genuinely bounce ten or fifteen times), this is exactly what stops the render
crawling. Building that closed test scene to actually demonstrate it with real
numbers is on the list for a future log.

## Splitting the render kernel in two

The last structural change was to break the single `render_kernel` into two:

- `trace_sample_kernel` traces one sample's full path for every pixel and adds
  its contribution into an accumulation buffer.
- `resolve_kernel` divides that accumulator by the number of samples so far to
  produce the image as it currently stands.

`main()` then loops over samples, launching both each time.

```cpp
for (int s = 0; s < cam.samples_per_pixel; s++) {
    trace_sample_kernel<<<grid, block>>>(d_accumBuffer, cam, /* ... */, s);
    CUDA_CHECK_KERNEL();

    resolve_kernel<<<grid, block>>>(d_accumBuffer, device_frameBuffer,
                                    numberOfPixels_X, numberOfPixels_Y, s + 1);
    CUDA_CHECK_KERNEL();
}
```

I went into this thinking it would be faster. It is not, and the reasons are
worth writing down because they corrected a wrong mental model I had about GPU
code.

Splitting a large `__device__` function into smaller ones changes nothing at all
about performance: `nvcc` inlines them regardless, and the generated code is the
same either way. Splitting into two *kernel launches* is a real change, but it
goes the wrong way: I now pay 100 launches where I used to pay one. Small, but
it's a cost, not a saving.

What I actually bought is **progressive rendering**. Because the accumulator is
resolved after every sample, there is now a complete, correct image in device
memory at every step: 1 sample in, 7 samples in, 50 samples in. Copying that
back mid-loop gives you the preview that every renderer you've ever used shows:
a noisy image immediately that cleans up as it converges. I'm not using it yet
(I still only copy back at the end), and writing a PPM every K samples is a
small follow-up.

### Where this leads: wavefront path tracing

There's a bigger idea behind the split, and I want to describe it carefully
rather than claim I've implemented it, because I haven't.

What I have is a **megakernel**: one kernel that does ray generation, traversal,
shading and the whole bounce loop inside itself. NVIDIA researchers wrote the
paper on why that's a problem, Laine, Karras and Aila's *Megakernels Considered
Harmful: Wavefront Path Tracing on GPUs* (HPG 2013), and the reasoning applies
directly to my code:

- **Threads finish at wildly different times.** GPU threads run in warps of 32,
  in lockstep. One path terminates after 2 bounces, its neighbour goes to 15, and the finished threads sit idle in the warp until the slowest one is done.
  Russian roulette makes this *worse*, not better: it terminates paths early, and
  right now an early-terminated path still occupies its warp slot to the end.
- **Different materials mean divergent branches.** Once I have Lambertian,
  dielectric and conductor materials, threads in the same warp hitting different
  materials take different branches, and the hardware has to run them one after another rather than together.
- **A big kernel needs a lot of registers**, and register pressure limits how
  many warps can be resident on an SM at once, which is exactly the occupancy
  you need to hide memory latency.

The wavefront answer is to split the renderer into small single-purpose kernels
(generate rays, intersect, shade by material) and run **stream compaction**
between the stages, rebuilding a tight list of the paths still alive so the next
kernel launches only for threads that will actually do work.

This is not academic: Blender's Cycles moved its GPU path to this architecture,
and OptiX is built around the same shape. Sorting live paths by *material* as
well as by liveness is the next refinement, so that threads hitting the same
material land in the same warp.

My two-kernel split has no compaction, and the whole bounce loop still lives
inside one kernel, so it's a first step in that direction rather than the thing
itself. The pieces that make it worth doing properly (a BVH, a scene big enough
to traverse, several material types, genuinely long paths) are all still ahead.

## One note on materials

I did add a `Material` struct this session, and the design question it raised is
a nice illustration of writing for a GPU rather than a CPU. The object-oriented
instinct is a base `Material` class with `Lambertian`, `Dielectric` and
`Conductor` subclasses and a virtual `scatter()`. On the GPU that's two problems
at once: virtual dispatch through a vtable makes threads in a warp diverge, and
objects with vtables don't survive a host-to-device `memcpy` cleanly, because the
vtable pointer is a host address. It's the same reasoning that kept `hit_sphere`
and `hit_triangle` as free functions instead of virtual methods.

So: one struct, a type tag, and a switch.

```cpp
enum class MaterialType { Lambertian, Dielectric, Conductor, Emissive };

struct Material {
    MaterialType type;
    vec3  albedo;
    vec3  emittedColor;
    float fuzz;
    float refractionIndex;
};
```

One thing I got right by thinking about it twice: `emittedColor` is a *field*,
not a type. Emission and reflectance are independent properties: a surface can both bounce incoming light and emit its own, and a glowing sphere that is also
slightly shiny is a perfectly ordinary object. Making `Emissive` a
mutually-exclusive enum value alongside the others would have made that
impossible to express. The struct is in place; wiring it into the shading loop,
which still reads albedo straight off the hit record, is the next job.

## Where things stand

Thin lens camera with depth of field, a floor, diffuse global illumination,
Russian roulette, an accumulation buffer resolved every sample. Still ahead, in
roughly the order I expect to get to them:

- Specular and dielectric materials: mirrors and glass, with Fresnel.
- An explicit pixel jitter, so antialiasing stops depending on the aperture.
- A BVH, and a scene layout worth traversing.
- Next event estimation and multiple importance sampling, the thing that separates this from a book exercise.
- A closed test scene, to finally measure what Russian roulette is worth.

Thanks for reading, and see you in the next one.