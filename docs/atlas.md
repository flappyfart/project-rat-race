# rat atlas asset

## source and credit

This is genuine Waxholm Space Sprague Dawley rat atlas **v4.01**, RRID **SCR_017124**, downloaded from the [NITRC project](https://www.nitrc.org/projects/whs-sd-atlas/). It is anatomical label segmentation based on structural MRI and diffusion tensor imaging, not activity data.

Credit: Kleven H, Bjerke IE, Clasca F et al. _Waxholm Space atlas of the rat brain: a 3D atlas supporting data analysis and integration._ Nature Methods 20, 1822-1829 (2023), [doi:10.1038/s41592-023-02034-3](https://doi.org/10.1038/s41592-023-02034-3). Also Papp et al. (2014), [doi:10.1016/j.neuroimage.2014.04.001](https://doi.org/10.1016/j.neuroimage.2014.04.001), and Kjonigsen et al. (2015), hippocampal delineations, [doi:10.1016/j.neuroimage.2014.12.080](https://doi.org/10.1016/j.neuroimage.2014.12.080). Display surfaces adapted by Project Rat Race. No institutional affiliation or endorsement implied.

**License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).** This is explicitly stated by the project summary and download agreement. The NITRC citation page says CC BY 4.0 but links to BY-SA 4.0, an upstream inconsistency recorded in the provenance. Retain attribution, license link and notice of modifications when reusing the derived files.

## files and integration

- `/data/rat-atlas.mesh.json`: 582,562 bytes; top-level flat `vertices`, `normals`, `indices` for the brain envelope. 5,947 vertices and 12,000 triangles.
- `regions[0]`: independent arrays for the bilateral union of CA1, CA2, CA3 and dentate gyrus, 2,002 vertices and 4,000 triangles. Label IDs 95, 96, 97, 98. This is not the entire hippocampal formation.
- `/data/atlas-provenance.json`: original URLs, resolved download URLs, full source and derived SHA-256 hashes, header verification, mesh counts, bounds, processing and limitations.
- `/assets/atlas-surface.png`: static rendering made directly from the same actual brain mesh, not generic illustration.

For Three.js, use `Float32BufferAttribute(data.vertices, 3)`, `Float32BufferAttribute(data.normals, 3)` and `setIndex(data.indices)`. The same applies to each region. Shared coordinates mean all parts must receive the same transform. Use a translucent envelope or hide it to inspect the internal region; nothing should pulse or imply activity.

Coordinates are **millimeters**, native NIfTI **RAS**: +x right, +y anterior, +z superior. They are not centered. Native bounds before decimal serialization: x [-8.4141511, 9.4613992], y [-24.3521600, 12.4572815], z [-5.4992923, 7.6069432]. Extents: 17.8755502 × 36.8094415 × 13.1062355 mm. Positions are rounded to four decimal places. For a y-up viewer, rotate the entire atlas group -pi/2 about x, then center the entire group using its bounding box. Do not center each region separately. NIfTI affine and hippocampal extents are in provenance.

## processing and limitations

The full source volume was decoded by nibabel: NIfTI-1 `n+1`, uint16, shape 512 × 1024 × 512, 0.0390625 mm isotropic voxels, RAS orientation. All 225 unique values including background resolve in the fetched label table; 41,232,040 voxels are nonzero.

Processing: nearest-neighbor stride 2 to 0.078125 mm grid; nonzero label union excluding explicit spinal cord and selected extracerebral structures (IDs and names in provenance); largest connected component; interior hole filling; Gaussian sigma 0.65 working voxels; marching cubes at 0.5; quadric-error simplification; area-weighted unit normals. Degenerate faces and unused vertices are removed, and rare opposing-face normal cancellations use an incident face normal. No cells or synthetic structures are inserted.

This is an **atlas-label envelope**, not a certified pial surface. Connected caudal gray/brainstem structures remain, including labels reaching the acquisition boundary; detached components and enclosed cavities are omitted. Do not interpret bounding extents as a precise biological brain measurement. Fine structures can be lost, and mesh topology is not guaranteed suitable for numerical analysis. This compact asset is for educational display, not clinical or quantitative analysis. The anatomy is not a population model, connectome, neuron reconstruction, living tissue, or whole-brain emulation. There are no activity, synapse, electrophysiology, learning or running simulation claims.

## reproducible build and validation

Original downloads and isolated tooling are in `.cache/atlas/`, outside public. The main repository owner should ignore `.cache/` in git. No package, application or server source files are modified by this task.

```sh
python3.11 -m venv .cache/atlas/py311
uv pip install --python .cache/atlas/py311/bin/python numpy==2.4.6 scipy==1.17.1 nibabel==5.4.2 scikit-image==0.26.0 fast-simplification==0.2.0 matplotlib==3.11.2
.cache/atlas/py311/bin/python scripts/build-atlas.py
```

The script downloads only when files are absent, validates gzip magic before nibabel decoding, resolves all label IDs, creates assets, reopens JSON and asserts finite arrays, valid indices, unit normals and total mesh size below 1,000,000 bytes. It reports real hashes and calculated counts. Python 3.9 was incompatible with fast-simplification's type annotations; the working build uses isolated Python 3.11.

NITRC initially returned HTTP 200 HTML agreement pages, not data. Following its actual download link with `?i_agree=1&download_now=1` retrieved the genuine bytes. Merely adding `i_agree=1` still returned HTML. The correct source segmentation is 3,973,835 bytes with SHA-256 `40d45344e9b5ef6b2c22ad9c834d69f34ed2a57b4e4300b6570813769c694cde`; labels are 16,929 bytes with SHA-256 `e30991cfce0ff03d1aba6bc10f2863fbe78087b7e380e7ecb508fcbd235839e7`. Final mesh SHA-256: `336ae1645872974f4bb4c107d432e5aee572479007ed999823974a327af1eae1`.
