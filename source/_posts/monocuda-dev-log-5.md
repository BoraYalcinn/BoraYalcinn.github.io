---
title: "MonoCUDA Dev Log #5"
date: 2026-10-25
description: "Motion blur, and then the big one: Next Event Estimation. Sampling the light directly instead of hoping a random bounce finds it, with uniform triangle sampling, the area to solid angle conversion, and shadow rays."
categories:
  - Dev
tags:
  - cuda
  - path-tracing
  - computer-graphics
  - graphics-programming
  - monte-carlo
  - sampling
  - gpu
cover: /images/blog/render-v16.jpg
featured: true
published: true
---
Hello folks, long time no see! Sorry for the gap. The last few weeks were busy:
midterms are less than two weeks away, I have a few projects running in
parallel, and I honestly felt a bit burnt out, so I took some time off the blog.
I'm back now.

Last time we rendered a Cornell box and went deep into some technical topics
like BVHs. Let's look at that final render again and see what is wrong with it
and what is missing.

![the Cornell box from the last log: red and green walls, a light in the ceiling, a mirror sphere and a floor covered in small coloured spheres, all of it grainy](/images/blog/render-v13.jpg)

Two problems are visible right away, and both have been there since the start of
the project: noise and fireflies (isolated, extremely bright pixels). Your first
guess might be "just too few samples per pixel", and that is partly true. But
more samples only hide the problem slowly; they don't fix the reason it happens.

Today we fix most of it. We will cover:

- Motion blur, a new feature
- Direct vs. indirect light
- Next Event Estimation (NEE): sampling the light directly
- Uniform sampling of a triangle light
- Shadow rays and the occlusion test, which NEE needs to know if the light is
  actually visible

NEE removes most of the noise and most of the fireflies. Some fireflies survive
(we'll see which ones and why), so at the end we also clamp them, and I'll be
honest about what that costs.

## What is wrong with the last render?

Let's get closer before we fix anything.

![a 2x crop of the last render: the back wall and the mirror sphere are covered in coloured speckle, and single white pixels sit on the wall](/images/blog/render-v13-noise-crop.jpg)

That is the same image, just zoomed in on the back wall and the mirror sphere.
The grain is everywhere, but notice where it is worst. The ceiling right around
the light panel is nearly clean, and the further a surface sits from the light,
the noisier it gets. The floor under the box and the lower half of the back wall
are the worst of it.

And then there are the single bright pixels sitting on a wall that is otherwise
a smooth grey. Those are the **fireflies**. One of them is not a slightly wrong
pixel, it is a pixel that got a value many times larger than its neighbours and
then had to share it with the other samples.

That render was 500 samples per pixel. So, why does a surface get darker *and*
noisier the further it is from the light? Hold that thought, because it is the
same question as "how does a path find the light at all", and that is section
three. First, something lighter.

## Motion blur

![a camera firing three rays at three different times, with the sphere drawn at t = 0.25, 0.5 and 0.75 between center0 and center1, and the smear the three of them add up to](/images/blog/motion-blur.png)

A real camera does not take a picture at an instant. The shutter stays open for
some length of time, and whatever is in front of it keeps moving while it is
open. Everything that moves during that window lands on the film smeared instead
of sharp. We have all seen it in a photo of a passing car.

Our renderer so far has an infinitely fast shutter. Every ray it fires sees the
scene frozen at exactly the same moment, so nothing can ever smear.

So what do we do about it? We give the ray a clock. Each ray gets a random time
\(t\) in the shutter interval, and the scene is asked what it looked like at
that time. The ray carries it as a field:

```cpp
struct Ray {
    vec3 origin;
    vec3 direction;
    float time;
    // ...
};
```

and the camera stamps every ray it generates with a fresh random one:

```cpp
float ray_time = curand_uniform(rngState);
// ...
return Ray(rayOriginOnLens, rayDirection, ray_time);
```

A sphere that moves gets a second centre and a flag. Where it is at time \(t\)
is just a lerp between the two:

```cpp
__host__ __device__ vec3 center_at(float t) const {
    return isMoving ? center + (center1 - center) * t : center;
}
```

and the intersection test asks for the centre at the ray's own time instead of
reading the stored one:

```cpp
__device__ bool hit_sphere(const sphere& targetSphere, const vec3& rayOrigin,
                           const vec3& rayDirection, float time, /* ... */) {
    vec3 cur_center = targetSphere.center_at(time);
    // ... the usual quadratic from here on
}
```

That is the whole feature. Look at the figure again: the blue, green and red
rays are three samples of the same pixel at three different times, each one
hitting the sphere in a different place, and the smear at the bottom is what you
get once a few dozen of them are averaged. The blur is not a filter applied
afterwards. It falls out of averaging samples that disagree about where the
sphere was.

There is one thing it breaks, though, and it is the BVH. A node's box has to
contain the primitive it holds, and a moving sphere is in a different place for
every \(t\). If the box only covered the sphere at \(t = 0\), a ray with
\(t = 0.8\) could miss the box, skip the subtree, and sail straight through a
sphere that was really there. So the box has to cover the whole path:

```cpp
__host__ __device__ void calculate_bounding_box(){
    vec3 rv(radius, radius, radius);
    AABB b0(center - rv, center + rv);
    if (!isMoving) {
        aabb = b0;
        return;
    }
    AABB b1(center1 - rv, center1 + rv);
    aabb = merge(b0, b1);
}
```

The union of the box at \(t=0\) and the box at \(t=1\). Correct, and a little
sad, because a fast object now owns a box far bigger than the object. Rays get
told "you might hit this" much more often than they really do, and traversal
pays for it. For a few bouncing spheres it does not matter. For a scene full of
fast movers it would, and that is a problem for a later log.

I made some of the small spheres in the Cornell box bounce to see it working:

![the Cornell box with the small floor spheres smeared vertically, still grainy everywhere](/images/blog/render-v14.jpg)

They are smeared, and the image is as noisy as it ever was. Which brings us to
the real topic.

## The problem: finding a small light by luck

![the left half of the figure: from a point P on the floor, a fan of grey arrows leaves in every direction over the hemisphere, and only one green arrow happens to reach the orange light panel above](/images/blog/bsdf-vs-nee.png)

Look at the left panel of that figure, the one labelled "BSDF sampling". That is
exactly what my renderer has been doing since log two. A path hits a diffuse
surface at the point \(P\), and the material picks the next direction. For a
Lambertian surface that means a random direction over the hemisphere, weighted
by the cosine, and nothing in that choice knows a light exists.

The grey arrows are all the directions it might pick. The one green arrow is a
direction that happens to land on the light.

Now count. The light is a small panel in the ceiling, so it covers a tiny
fraction of the hemisphere seen from \(P\). Nearly every direction we pick
misses it and comes back with whatever the walls happen to be carrying, which
near the floor is not much. Once in a while one lands on the panel, and that
sample comes back carrying the full brightness of a light that had to be much
brighter than 1 to light the room at all.

So for one pixel we have a pile of samples that found almost nothing, and the
occasional sample worth fifty of them. Average those and you get the right
answer eventually, which is why the image is not wrong, just ugly. The spread
between the samples is the noise, and a single huge sample in a pixel whose
neighbours got none is a firefly.

And now the earlier question answers itself. The further a surface is from the
light, the smaller the light looks from there, so the fewer random directions
find it, and the noisier that part of the image gets.

More samples per pixel shrink the spread, but slowly: four times the samples for
half the noise. We are not going to fix this by waiting longer.

## Direct vs. indirect light

![two panels: on the left, light leaves the panel, bounces once off the floor and reaches the eye; on the right, it bounces off a red wall at A, then off the floor at B, and only then reaches the eye](/images/blog/direct-vs-indirect.png)

Before the fix, a distinction worth making out loud, because the fix only
applies to one half of it.

On the left is **direct light**. It leaves the light panel, hits a surface once,
and goes to the eye. One bounce. It is the bulk of the brightness in a room and
it is the part your eye reads as "this is lit".

On the right is **indirect light**. It leaves the panel, hits the red wall at
\(A\), picks up its colour, hits the floor at \(B\), and only then reaches the
eye. Two bounces, or ten. This is colour bleeding, the soft fill in the corners,
the reason the white box in the Cornell box has a red side and a green side. It
is the part that makes a render look like a photograph instead of a diagram.

Up to now my renderer made no distinction at all. Both of those were found by
the same process: bounce randomly and hope. The idea behind the fix is to stop
treating them the same:

- **direct**: at every bounce, sample the light explicitly, because we know
  exactly where it is
- **indirect**: keep bouncing randomly, because we have no idea where the rest
  of the light is coming from and random is still the honest answer

Here is the same thing as a table:

| | Direct | Indirect |
|---|---|---|
| Path | light to surface to eye | light to A to B to eye |
| How we find it | aim at the light on purpose | random bounce, as before |
| Cost per hit | one extra ray | nothing extra |
| What it contributes | most of the brightness | colour bleeding, soft fill |

## Next Event Estimation

![the right half of the figure: from the same point P, a single green arrow goes straight to an orange dot on the light panel](/images/blog/bsdf-vs-nee.png)

Now the right panel of the same figure. One arrow. No fan.

The trick, which has the slightly grand name **Next Event Estimation**, is
embarrassingly simple once you see it: at every hit, instead of waiting for a
random direction to find the light, pick a point \(Y\) on the light yourself and
connect \(P\) to it. The orange dot on the panel in the figure is \(Y\). We
asked for it, so we always get it.

What that connection is worth is

$$\text{emission} \cdot \text{BSDF} \cdot \cos\theta_{\text{surface}} \cdot \frac{\cos\theta_{\text{light}}}{d^2} \cdot \frac{1}{\text{pdf}_{\text{area}}}$$

Reading it left to right: the light's emitted colour, the surface's BSDF for
that direction, the cosine at our end because a surface lit at a glancing angle
receives less, the cosine at the light's end and the inverse square falloff
because the panel looks smaller and dimmer from further away, and finally we
divide by the probability density we sampled \(Y\) with, as every Monte Carlo
estimator must.

There is usually more than one light. I pick one uniformly and divide by how
many there are, which in code is the `lightSelectionProbability`:

```cpp
int selectedLightIndex = min((int)(curand_uniform(&rngState) * lightCount), lightCount - 1);
const Light& selectedLight = lights[selectedLightIndex];
float lightSelectionProbability = 1.0f / float(lightCount);
```

The lights themselves are not a new primitive type. When the scene is built,
every triangle whose material is emissive gets an entry in a light list, along
with the two things sampling will need, its area and its normal:

```cpp
if(scene.triangles[i].mat.type == MaterialType::Emissive){
    triangle& emissiveTriangle = scene.triangles[i];
    vec3 edgeOne = emissiveTriangle.v1 - emissiveTriangle.v0;
    vec3 edgeTwo = emissiveTriangle.v2 - emissiveTriangle.v0;

    vec3 areaVector = edgeOne.cross(edgeTwo);

    Light light;
    light.sourceTriangle = emissiveTriangle;
    light.surfaceArea = 0.5f * areaVector.length();
    light.surfaceNormal = areaVector.normalize();
    scene.lights.push_back(light);
}
```

Half the length of the cross product is the triangle's area, and the normalized
cross product is its normal. The ceiling panel in the Cornell box is two
triangles, so it becomes two lights, and picking uniformly between them is
exactly right because they are the same size.

## Uniform sampling of a triangle

![three panels: uniform points in a square with the half above the diagonal marked in red, the same square with the upper half folded back onto the lower one, and the resulting points spread evenly inside a triangle A B C](/images/blog/uniform-triangle-sampling.png)

So we need a random point \(Y\) on a triangle, and we need it *uniform*, meaning
every bit of the triangle equally likely. Otherwise the estimator is weighted
toward whatever corner we favoured and the picture is wrong in a way no number
of samples will fix.

The obvious thing does not work. Take two random numbers \(r_1, r_2\) in
\([0,1]\) and use them as barycentric weights, and look at the left panel: half
your points land above the diagonal, which is outside the triangle. You have
thrown away half your samples.

The middle panel is one way out. Fold the bad half back over the diagonal onto
the good half. It works, and it is uniform, and it costs a branch.

The right panel is what I actually use:

$$P = (1 - \sqrt{r_1})\,A + \sqrt{r_1}(1 - r_2)\,B + \sqrt{r_1}\,r_2\,C$$

No branch, no rejection, every pair of random numbers produces a usable point.
The square root is the part worth staring at. Without it the points pile up near
vertex \(A\), because the amount of triangle at a given distance from \(A\)
grows as you move away from it, while a plain uniform \(r_1\) hands out the same
share of points to every band. Taking the square root stretches the numbers out
to match the area they are covering. The same reason you see \(\sqrt{\cdot}\)
when sampling a disk.

In code:

```cpp
__device__ vec3 sample_triangle(const triangle& tri,curandState* rngState){
    float randomValue_1 = curand_uniform(rngState);
    float randomValue_2 = curand_uniform(rngState);
    // we are taking its squareRoot so that the random values spread out evenly inside the triangle
    float sqrtRandom_1 = sqrtf(randomValue_1);

    float weightOfVertex0 = 1.0f - sqrtRandom_1;
    float weightOfVertex1 = randomValue_2 * sqrtRandom_1;
    float weightOfVertex2 = 1.0f - weightOfVertex0 - weightOfVertex1;

    return tri.v0 * weightOfVertex0 + tri.v1 * weightOfVertex1 + tri.v2 * weightOfVertex2;
}
```

Since the point is uniform over the surface, the probability density is the same
everywhere on it and it is simply

$$\text{pdf}_{\text{area}} = \frac{1}{\text{area}}$$

which is why the light's area got stored back when the scene was built.

## From area to solid angle

This is the heart of NEE and the part I had to draw before I believed it, so
take your time here.

We have two things that do not speak the same language. The BSDF, and the whole
bounce loop around it, works in **directions**. It answers questions of the form
"of the light arriving from this direction, how much goes that way". But we just
sampled \(Y\) in **area**, square metres on the surface of a triangle, and our
pdf is one over that area.

Putting an area density into a directional estimator is a unit mismatch, and a
unit mismatch in a renderer shows up as an image that is too bright or too dark
by a factor nobody can guess. So we convert:

$$\text{pdf}_{\omega} = \text{pdf}_{\text{area}} \cdot \frac{d^2}{\cos\theta_{\text{light}}}$$

Two factors, and both of them are just the light getting smaller as you move it
away or tilt it. Move the panel twice as far and it covers a quarter of the
directions, hence \(d^2\). Tilt it until you are looking along its surface and
it covers almost none, hence the \(\cos\theta_{\text{light}}\).

In my code the conversion and the light selection probability are folded into
one number:

```cpp
vec3 sampledPointOnLight = sample_triangle(selectedLight.sourceTriangle, &rngState);
vec3 vectorToLight = sampledPointOnLight - hit.hitPoint;
float distanceToLight = vectorToLight.length();
vec3 directionToLight = vectorToLight / distanceToLight;

float cosineAtSurface = hit.hitNormal.dot(directionToLight);
float cosineAtLight = fabsf(selectedLight.surfaceNormal.dot(directionToLight));
```

```cpp
float solidAnglePdf = lightSelectionProbability * (distanceToLight * distanceToLight)
                    / (cosineAtLight * selectedLight.surfaceArea);
```

That one line is \(\frac{1}{N_{\text{lights}}} \cdot \frac{1}{\text{area}} \cdot
\frac{d^2}{\cos\theta_{\text{light}}}\) with the \(1/\text{area}\) written as a
division. `fabsf` on the light's cosine is there so a panel facing away from us
in its stored orientation still works; we care how steeply we see it, not which
way its normal was written down.

The contribution then goes in like this:

```cpp
vec3 lightColor = selectedLight.sourceTriangle.mat.emittedColor;
sampleColor = sampleColor + attenuation * lightColor * (cosineAtSurface / (MONOCUDA_PI * solidAnglePdf));
```

The Lambertian BSDF is \(\text{albedo}/\pi\), and both halves of it are in there:
the albedo is already inside `attenuation`, which was multiplied by it one line
above the NEE block, and the \(\pi\) is the explicit division. The surface
cosine is in the numerator, and everything else is in `solidAnglePdf`.

## Shadow ray and the occlusion test

![two panels: on the left a green ray from P reaches the orange point Y on the light unobstructed; on the right a red ray from P is stopped by a grey sphere before it gets there, with the rest of the way to Y drawn as a dashed line](/images/blog/shadow-ray-occlusion.png)

There is a hole in everything above. We happily connected \(P\) to \(Y\) and
collected the light's energy without ever asking whether there is a wall in the
way. Do that and nothing in the scene casts a shadow.

So we trace one more ray, from \(P\) toward \(Y\), and the only thing we want
from it is a yes or no. That is the **shadow ray**, and the figure is the whole
idea: green on the left, nothing in between, the contribution counts. Red on the
right, a sphere in the way, the contribution is zero and we move on.

```cpp
if (cosineAtSurface > 0.0f && cosineAtLight > 1e-4f) {
    hitRecord shadowHit = bvh.traverseRay(hit.hitPoint, directionToLight, r.time,
                                          spheres, triangles, distanceToLight * 0.999f);

    if (!shadowHit.didHit) {
        // ... add the contribution
    }
}
```

Two guards before we even bother. `cosineAtSurface > 0.0f` throws out the case
where the light is behind the surface we are standing on, and the tiny threshold
on the light's cosine throws out the case where we are looking at the panel
edge-on, where the solid angle pdf would blow up.

Then two details in the trace itself, both of them the same kind of problem.

The ray starts at the surface we are standing on, so the first thing it is
liable to hit is that surface, from a floating point rounding error of a
distance away. A ray origin pushed out along the normal by a small \(\epsilon\)
is what stops the surface shadowing itself.

The other end has the same issue in reverse. We are aiming *at* the light, so of
course the ray hits it, and if we let that count as an occluder every light in
the scene would shadow itself and the room would be black. Hence the
`distanceToLight * 0.999f` passed as the maximum distance: stop just short of
the thing we are aiming at. The figure's dashed line on the right is the part of
the segment we never trace.

And notice we do not need to know *what* the shadow ray hit, or where, or how
far. Only whether it hit anything at all. That is a weaker question than the one
`traverseRay` answers, and a weaker question can be answered faster. More on
that next time.

## Don't count the light twice

Here is the bug that NEE walks you straight into, and it took me a while to
convince myself of the fix.

NEE now accounts for direct light at every bounce. But the ordinary BSDF ray is
still bouncing around too, and sometimes it lands on the light panel by luck,
exactly as it always did. If we add the emission then as well, every bit of
direct light goes into the image twice, and the render comes out too bright.

So emission found by a BSDF ray is only counted in two cases:

```cpp
if (depth == 0 || previousBounceWasSpecular) {
    sampleColor = sampleColor + attenuation * hit.mat.emittedColor;
}
```

`depth == 0` is the camera ray looking straight at the panel. Nobody sampled
that, so it has to be counted here, otherwise the light itself renders black.

`previousBounceWasSpecular` is the mirror and the glass. My NEE block only runs
on Lambertian surfaces, because a perfect mirror reflects exactly one direction
and the chance that it is the one pointing at \(Y\) is zero. So a specular
surface never did a light sample, and the emission its reflected ray finds has
not been counted anywhere yet. The flag is set at the end of each bounce:

```cpp
previousBounceWasSpecular = (hit.mat.type != MaterialType::Lambertian);
```

and it starts out `true`, which is what makes the `depth == 0` case work for
free.

This whole dance is a blunt version of a real question: when two different
strategies can both find the same path, how should their answers be combined?
Counting one and ignoring the other is the cheapest possible answer. The proper
one is Multiple Importance Sampling, and it is not in the code yet.

One more ordering detail. The NEE block sits **before** the Russian roulette
check. Roulette kills low-energy paths to save work, and a killed path never
reaches the rest of the loop, so running NEE after it would throw away the
direct light at exactly the dim bounces that are hardest to get clean.

## Results

Here is the same scene before and after, at 500 samples per pixel.

![before NEE: the Cornell box with motion blurred spheres, heavy coloured grain over every surface](/images/blog/render-v14.jpg)

![after NEE: the same scene, the grain almost entirely gone, with a handful of isolated white pixels left on the walls](/images/blog/render-v15.jpg)

That is the same sample count. The grain that covered every surface is basically
gone, and the gradient across the back wall, which the noise was hiding, is
visible now. The dark corners came up too, because a corner is where random
directions were least likely to find the panel and NEE does not care.

What did not go away is the handful of white pixels still sitting on the walls.
Those are the fireflies NEE cannot touch, and the reason is in the previous
section: NEE only runs on diffuse surfaces. A path that goes through the glass
spheres or off the mirror and *then* finds the light is still being found the
old way, by luck, and it still comes back carrying far too much energy for one
sample.

The blunt fix is to refuse to accept a sample above a certain brightness:

```cpp
// to reduce firefly points
float brightestChannel = fmaxf(sampleColor.x,fmaxf(sampleColor.y,sampleColor.z));
const float maximumSampleBrightness = 10.0f;
if(brightestChannel > maximumSampleBrightness){
    sampleColor = sampleColor * (maximumSampleBrightness / brightestChannel);
}
```

![after NEE and the clamp: the same scene again with the remaining white pixels gone](/images/blog/render-v16.jpg)

And I should be honest about what that line costs, because it is not free and it
is not clever. Clamping throws energy away. Those enormous samples were not
mistakes, they were rare paths that really do carry that much light, and the
average is only correct if we let them in. Cut them off and the image is
**biased**: slightly darker than the right answer, and no number of samples will
converge back to it. I traded a correct noisy image for a wrong clean one, which
is a trade renderers make all the time, but it is worth knowing you made it.

The principled fix for part of this is MIS, which would let the BSDF ray and the
light sample share credit for the paths they can both find, instead of one of
them going uncounted and arriving as a spike.

## What's next

Multiple Importance Sampling first, so the specular paths stop producing spikes
and the clamp can come back out.

After that, the thing I have been circling for two logs: the shading loop is one
enormous kernel where every thread does a different thing, and that is not what
a GPU wants. Wavefront path tracing, and a profiling session in Nsight to show
why.

Most of what I know about this material started with Peter Shirley's
[Ray Tracing in One Weekend series](https://raytracing.github.io/), which is
where I would send anyone wanting the ground floor version of it.

See you in the next one.
