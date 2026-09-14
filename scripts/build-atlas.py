#!/usr/bin/env python3
"""Build genuine WHS label-derived display surfaces. Dependencies in docs/atlas.md."""
from pathlib import Path
import hashlib, json, re, urllib.request, datetime
import numpy as np
import nibabel as nib
from scipy import ndimage
from skimage.measure import marching_cubes
import fast_simplification
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache/atlas'
OUT = ROOT / 'public/data'
CACHE.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)
SOURCES = {'segmentation': ('13398', 'WHS_SD_rat_atlas_v4.01.nii.gz'), 'labels': ('13399', 'WHS_SD_rat_atlas_v4.01.label')}
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
def dump(path, obj):
    path.write_text(json.dumps(obj, separators=(',', ':'), allow_nan=False))
source_records = {}
for kind, (fid, name) in SOURCES.items():
    url = f'https://www.nitrc.org/frs/download.php/{fid}/{name}'
    download = url + '/?i_agree=1&download_now=1'
    path = CACHE / name
    if not path.exists():
        urllib.request.urlretrieve(download, path)
    if kind == 'segmentation':
        assert path.read_bytes()[:2] == b'\x1f\x8b', 'Not gzip: possible NITRC agreement HTML'
    else:
        assert path.read_text().startswith('####'), 'Not ITK-SNAP label text'
    source_records[kind] = {'url': url, 'downloadUrl': download, 'sha256': sha(path), 'bytes': path.stat().st_size}
im = nib.load(CACHE / SOURCES['segmentation'][1])
assert bytes(im.header['magic']).startswith(b'n+1')
assert im.header.get_xyzt_units()[0] == 'mm'
a = np.asanyarray(im.dataobj)
ids, counts = np.unique(a, return_counts=True)
labels = {int(m[1]): m[2] for m in re.finditer(r'^\s*(\d+)\s+.*?"([^"]+)"', (CACHE / SOURCES['labels'][1]).read_text(), re.M)}
assert set(map(int, ids)).issubset(labels)
# Work on a 2x nearest-neighbor label grid (78.125 um), never inventing labels.
b = a[::2, ::2, ::2]
# Exclude explicit extracerebral anatomy and spinal cord from the display envelope.
excluded = [45, 119, 120, 121, 122, 162, 504]
mask = (b != 0) & ~np.isin(b, excluded)
cc, n = ndimage.label(mask)
sizes = np.bincount(cc.ravel()); sizes[0] = 0
mask = cc == sizes.argmax()
mask = ndimage.binary_fill_holes(mask)
def surface(mask, target):
    field = ndimage.gaussian_filter(np.pad(mask, 1).astype(np.float32), sigma=0.65)
    v, f, _, _ = marching_cubes(field, level=0.5, allow_degenerate=False, gradient_direction='ascent')
    v = nib.affines.apply_affine(im.affine, (v - 1) * 2)
    before = {'vertices': len(v), 'triangles': len(f)}
    v, f = fast_simplification.simplify(v, f, target_count=target, agg=5)
    area = np.linalg.norm(np.cross(v[f[:,1]]-v[f[:,0]], v[f[:,2]]-v[f[:,0]]), axis=1)
    f = f[area > 1e-12]
    used, remap = np.unique(f, return_inverse=True)
    v = v[used]; f = remap.reshape(-1, 3)
    # Ensure outward winding using signed volume of the closed surface.
    volume = np.einsum('ij,ij->i', v[f[:,0]], np.cross(v[f[:,1]], v[f[:,2]])).sum()/6
    if volume < 0:
        f = f[:, ::-1].copy()
    normals = np.zeros_like(v)
    fn = np.cross(v[f[:,1]]-v[f[:,0]], v[f[:,2]]-v[f[:,0]])
    for j in range(3):
        np.add.at(normals, f[:,j], fn)
    zero = np.linalg.norm(normals, axis=1) < 1e-12
    # Rare opposing-face cancellations: use an incident nondegenerate face normal.
    for face, normal in zip(f, fn):
        for index in face:
            if zero[index]:
                normals[index] = normal
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-15)
    obj = {'vertices': np.round(v, 4).ravel().tolist(), 'normals': np.round(normals, 4).ravel().tolist(), 'indices': f.ravel().tolist()}
    stats = {'vertices': len(v), 'triangles': len(f), 'beforeSimplification': before, 'boundsMm': [v.min(0).tolist(), v.max(0).tolist()], 'extentsMm': np.ptp(v, axis=0).tolist()}
    return obj, stats
mesh, stats = surface(mask, 12000)
hip_ids = [95, 96, 97, 98]
hip, hip_stats = surface(np.isin(b, hip_ids), 4000)
hip.update({'id': 'hippocampus', 'name': 'hippocampus: CA1, CA2, CA3 and dentate gyrus', 'labelIds': hip_ids})
mesh.update({'schemaVersion': 1, 'units': 'mm', 'orientation': 'RAS', 'axes': {'x': 'right', 'y': 'anterior', 'z': 'superior'}, 'regions': [hip], 'bounds': stats['boundsMm'], 'source': 'Waxholm Space Sprague Dawley rat atlas v4.01'})
meshpath = OUT / 'rat-atlas.mesh.json'
dump(meshpath, mesh)
# Static fallback is rasterized from the same actual JSON geometry, no illustrative anatomy.
fig = plt.figure(figsize=(12, 8), dpi=140, facecolor='#e8e9e3')
ax = fig.add_subplot(111, projection='3d', facecolor='#e8e9e3')
v = np.array(mesh['vertices']).reshape(-1, 3); f = np.array(mesh['indices']).reshape(-1, 3)
fn = np.cross(v[f[:,1]]-v[f[:,0]], v[f[:,2]]-v[f[:,0]])
fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-15)
light = np.array([-.4, -.3, 1]); light /= np.linalg.norm(light)
shade = .55 + .4*np.maximum(0, fn @ light)
colors = np.column_stack([shade*.53, shade*.59, shade*.57, np.ones(len(f))])
ax.add_collection3d(Poly3DCollection(v[f], facecolors=colors, linewidths=0, rasterized=True))
lo, hi = v.min(0), v.max(0)
ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1]); ax.set_zlim(lo[2], hi[2]); ax.set_box_aspect(hi-lo)
ax.view_init(elev=28, azim=-43); ax.set_axis_off()
fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
image = ROOT / 'public/assets/atlas-surface.png'
image.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(image, facecolor=fig.get_facecolor(), bbox_inches='tight', pad_inches=0)
plt.close(fig)
provenance = {
 'title': 'Waxholm Space atlas of the Sprague Dawley rat brain', 'atlasRelease': 'v4.01', 'rrid': 'SCR_017124',
 'modality': 'Anatomical label segmentation delineated using structural MRI and diffusion tensor imaging; not activity data',
 'license': {'id': 'CC-BY-4.0', 'url': 'https://creativecommons.org/licenses/by/4.0/', 'evidenceUrl': 'https://www.nitrc.org/projects/whs-sd-atlas/', 'note': 'Project summary and download agreement explicitly state CC BY 4.0. Citation page also says CC BY 4.0 but its hyperlink points to BY-SA 4.0; this inconsistency is retained here, not silently ignored.'},
 'attribution': 'Waxholm Space atlas: Kleven, Bjerke, Clasca et al. (2023); Papp, Leergaard, Calabrese, Johnson and Bjaalie (2014); hippocampal delineations Kjonigsen et al. (2015). Display mesh adapted by Project Rat Race. No affiliation or endorsement implied.',
 'citation': 'Kleven H, Bjerke IE, Clasca F et al. Waxholm Space atlas of the rat brain: a 3D atlas supporting data analysis and integration. Nature Methods 20, 1822-1829 (2023).',
 'citationUrls': ['https://www.nitrc.org/citation/?group_id=1081', 'https://doi.org/10.1038/s41592-023-02034-3', 'https://doi.org/10.1016/j.neuroimage.2014.04.001', 'https://doi.org/10.1016/j.neuroimage.2014.12.080'],
 'sourceUrl': 'https://www.nitrc.org/projects/whs-sd-atlas/', 'sources': source_records,
 'retrievedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'verification': {'format': 'NIfTI-1 single-file gzip; nibabel full volume decoded', 'magic': 'n+1', 'shape': list(im.shape), 'dtype': str(a.dtype), 'voxelSpacingMm': list(map(float, im.header.get_zooms())), 'orientation': ''.join(nib.aff2axcodes(im.affine)), 'affine': im.affine.tolist(), 'uniqueLabelsIncludingBackground': len(ids), 'allLabelsResolved': True, 'nonzeroVoxels': int(np.count_nonzero(a))},
 'processing': {'gridStride': 2, 'gaussianSigmaWorkingVoxels': .65, 'isovalue': .5, 'algorithm': 'largest connected nonzero-label brain component, fill interior holes, Gaussian smoothing, marching cubes, quadric-error simplification, area-weighted normals', 'excludedLabels': {str(k): labels[k] for k in excluded}, 'hippocampusLabels': {str(k): labels[k] for k in hip_ids}, 'positionPrecisionMm': .0001},
 'geometry': {'path': '/data/rat-atlas.mesh.json', 'sha256': sha(meshpath), 'bytes': meshpath.stat().st_size, 'brain': stats, 'regions': {'hippocampus': hip_stats}, 'units': 'mm', 'orientation': 'RAS', 'centered': False},
 'fallback': {'path': '/assets/atlas-surface.png', 'sha256': sha(image), 'bytes': image.stat().st_size},
 'limitations': ['Display-only simplified anatomical envelope, not the original full-resolution segmentation.', 'Single atlas reference anatomy is not a population model, connectome, neuron reconstruction, living tissue, or whole-brain emulation.', 'No cells, synapses, electrophysiology, activity, learning, or simulation state are represented.', 'Envelope includes connected atlas structures, fills enclosed holes and omits detached components; it is not a histological pial surface.', 'Hippocampus overlay is only the explicitly listed bilateral label union, not the entire hippocampal formation.', 'Small structures and fine boundaries can be lost in resampling and simplification. Not for quantitative or clinical measurement.']}
dump(OUT / 'atlas-provenance.json', provenance)
# Check serialized arrays, valid indices, normals and size, not just in-memory data.
loaded = json.loads(meshpath.read_text())
for part in [loaded] + loaded['regions']:
    vv = np.array(part['vertices']).reshape(-1, 3)
    nn = np.array(part['normals']).reshape(-1, 3)
    ff = np.array(part['indices']).reshape(-1, 3)
    assert vv.shape == nn.shape and np.isfinite(vv).all() and np.isfinite(nn).all()
    assert ff.min() >= 0 and ff.max() < len(vv)
    assert np.allclose(np.linalg.norm(nn, axis=1), 1, atol=.001)
assert meshpath.stat().st_size < 1_000_000
print(json.dumps({'sources': source_records, 'verification': provenance['verification'], 'geometry': provenance['geometry'], 'fallback': provenance['fallback']}, indent=2))
