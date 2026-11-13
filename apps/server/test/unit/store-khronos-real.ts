/*
 * A snapshot of the real Khronos glTF-Sample-Assets repository (November 2026), for checking the
 * store against what it really lists: every model of Models/model-index.json (name | tags |
 * variants; labels, screenshots and file names left out) and the metadata.json of two models whose
 * legal entries hold trademark notices and licences given by a relative URL.
 */

const INDEX_TABLE = `
ABeautifulGame | showcase,video,extension | glTF,glTF-Binary,glTF-Binary-KTX-ETC1S-Draco
AlphaBlendModeTest | core,testing | glTF,glTF-Binary
AnimatedColorsCube | extension,testing | glTF,glTF-Binary
AnimatedCube | core,testing | glTF
AnimatedMorphCube | core,testing | glTF,glTF-Binary,glTF-Quantized
AnimatedTriangle | core,testing,written | glTF,glTF-Embedded
AnimationPointerUVs | extension,testing | glTF,glTF-Binary
AnisotropyBarnLamp | showcase,extension | glTF,glTF-Binary,glTF-KTX-BasisU
AnisotropyDiscTest | extension,testing | glTF,glTF-Binary
AnisotropyRotationTest | extension,testing | glTF,glTF-Binary
AnisotropyStrengthTest | extension,testing | glTF,glTF-Binary
AntiqueCamera | core,testing,issues | glTF,glTF-Binary
AttenuationTest | testing,extension | glTF,glTF-Binary
Avocado | core,testing | glTF,glTF-Binary,glTF-Draco,glTF-Quantized
BarramundiFish | core,testing | glTF,glTF-Binary,glTF-Draco
BoomBox | core,testing | glTF,glTF-Binary,glTF-Draco
BoomBoxWithAxes | core,testing | glTF
Box | core,testing | glTF,glTF-Binary,glTF-Draco,glTF-Embedded
Box With Spaces | core,testing | glTF
BoxAnimated | core,testing | glTF,glTF-Binary,glTF-Embedded
BoxInterleaved | core,testing | glTF,glTF-Binary,glTF-Embedded
BoxTextured | core,issues,testing | glTF,glTF-Binary,glTF-Embedded
BoxTexturedNonPowerOfTwo | core,issues,testing | glTF,glTF-Binary,glTF-Embedded
BoxVertexColors | core,testing | glTF,glTF-Binary,glTF-Embedded
BrainStem | core,testing | glTF,glTF-Binary,glTF-Draco,glTF-Embedded,glTF-Meshopt,glTF-Meshopt-EXT
Cameras | core,testing | glTF,glTF-Embedded
CarConcept | showcase,extension | glTF,glTF-Binary,glTF-JPG,glTF-KTX-BasisU-Draco,glTF-WEBP
CarbonFibre | extension | glTF,glTF-Binary
CesiumMan | core,issues,testing | glTF,glTF-Binary,glTF-Draco,glTF-Embedded
CesiumMilkTruck | core,issues,testing | glTF,glTF-Binary,glTF-Draco,glTF-Embedded
ChairDamaskPurplegold | extension | glTF,glTF-Binary
ChronographWatch | showcase,extension | glTF,glTF-Binary,glTF-KTX-BasisU,glTF-WEBP
ClearCoatCarPaint | extension,testing | glTF,glTF-Binary
ClearCoatTest | testing,extension | glTF,glTF-Binary
ClearcoatWicker | extension,testing | glTF,glTF-Binary
CommercialRefrigerator | showcase,extension | glTF,glTF-Binary
CompareAlphaCoverage | core,testing,pbrtest | glTF,glTF-Binary
CompareAmbientOcclusion | core,testing,pbrtest | glTF,glTF-Binary
CompareAnisotropy | extension,testing,pbrtest | glTF,glTF-Binary
CompareBaseColor | testing,pbrtest | glTF,glTF-Binary
CompareClearcoat | extension,testing,pbrtest | glTF,glTF-Binary
CompareDispersion | extension,testing,pbrtest | glTF,glTF-Binary
CompareEmissiveStrength | extension,testing,pbrtest | glTF,glTF-Binary
CompareIor | extension,testing,pbrtest | glTF,glTF-Binary
CompareIridescence | extension,testing,pbrtest | glTF,glTF-Binary
CompareMetallic | core,testing,pbrtest | glTF,glTF-Binary
CompareNormal | core,testing,pbrtest | glTF,glTF-Binary
CompareRoughness | core,testing,pbrtest | glTF,glTF-Binary
CompareSheen | extension,testing,pbrtest | glTF,glTF-Binary
CompareSpecular | extension,testing,pbrtest | glTF,glTF-Binary
CompareTransmission | extension,testing,pbrtest | glTF,glTF-Binary
CompareVolume | extension,testing,pbrtest | glTF,glTF-Binary
Corset | core,testing | glTF,glTF-Binary,glTF-Draco
Cube | core,testing | glTF
CubeVisibility | testing | glTF,glTF-Binary
DamagedHelmet | core,showcase,testing,video | glTF,glTF-Binary,glTF-Embedded
DiffuseTransmissionPlant | showcase,extension | glTF,glTF-Binary
DiffuseTransmissionTeacup | showcase,extension | glTF,glTF-Binary
DiffuseTransmissionTest | video,written,extension | glTF,glTF-Binary
DirectionalLight | testing | glTF,glTF-Binary
DispersionTest | extension,testing | glTF,glTF-Binary
DragonAttenuation | extension | glTF,glTF-Binary,glTF-Meshopt,glTF-Meshopt-EXT
DragonDispersion | extension | glTF,glTF-Binary
Duck | core,testing | glTF,glTF-Binary,glTF-Draco,glTF-Embedded,glTF-Quantized
EmissiveStrengthTest | testing,extension | glTF,glTF-Binary
EnvironmentTest | testing,extension | glTF,glTF-IBL
FlightHelmet | showcase,testing | glTF,glTF-KTX-BasisU
Fox | core,testing | glTF,glTF-Binary
GlamVelvetSofa | video,extension | glTF,glTF-Binary
GlassBrokenWindow | video,extension | glTF,glTF-Binary
GlassHurricaneCandleHolder | video,written,showcase,extension | glTF,glTF-Binary
GlassVaseFlowers | video,extension | glTF,glTF-Binary
IORTestGrid | extension | glTF,glTF-Binary
InterpolationTest | core,testing | glTF,glTF-Binary
IridescenceAbalone | extension | glTF,glTF-Binary
IridescenceDielectricSpheres | testing,extension | glTF
IridescenceLamp | showcase,extension | glTF,glTF-Binary
IridescenceMetallicSpheres | testing,extension | glTF
IridescenceSuzanne | testing,extension | glTF,glTF-Binary
IridescentDishWithOlives | showcase,video,extension | glTF,glTF-Binary
Lantern | core,testing | glTF,glTF-Binary,glTF-Draco,glTF-Quantized
LightVisibility | testing | glTF,glTF-Binary
LightsPunctualLamp | testing,extension | glTF,glTF-Binary
MandarinOrange | extension,testing | glTF
MaterialsVariantsShoe | extension,showcase,written | glTF,glTF-Binary
MeshPrimitiveModes | testing | glTF,glTF-Embedded
MeshoptCubeTest | extension,testing | glTF,glTF-Meshopt
MetalRoughSpheres | core,testing | glTF,glTF-Binary,glTF-Embedded
MetalRoughSpheresNoTextures | core,testing | glTF,glTF-Binary
MorphPrimitivesTest | core,testing | glTF,glTF-Binary,glTF-Draco
MorphStressTest | core,testing | glTF,glTF-Binary
MosquitoInAmber | showcase,extension | glTF,glTF-Binary
MultiUVTest | core,testing | glTF,glTF-Binary,glTF-Embedded
MultipleScenes | core,testing | glTF,glTF-Embedded
NegativeScaleTest | core,testing | glTF,glTF-Binary
NodePerformanceTest | testing | glTF,glTF-Binary
NodeVisibilityTest | testing | glTF,glTF-Binary
NormalTangentMirrorTest | core,testing | glTF,glTF-Binary
NormalTangentTest | core,testing | glTF,glTF-Binary
OrientationTest | core,testing | glTF,glTF-Binary,glTF-Embedded
PlaysetLightTest | test | glTF,glTF-Binary
PointLightIntensityTest | extension,testing | glTF,glTF-Binary
PotOfCoals | showcase,extension | glTF,glTF-Binary
PotOfCoalsAnimationPointer | showcase,extension | glTF,glTF-Binary
PrimitiveModeNormalsTest | core,issues,testing | glTF
RecursiveSkeletons | core,testing,issues | glTF,glTF-Binary
RiggedFigure | core,testing | glTF,glTF-Binary,glTF-Draco,glTF-Embedded
RiggedSimple | core,testing | glTF,glTF-Binary,glTF-Draco,glTF-Embedded
ScatteringSkull | testing | glTF,glTF-Binary
SciFiHelmet | core,testing | glTF
SheenChair | showcase,video,extension | glTF,glTF-Binary
SheenCloth | showcase,video,extension | glTF
SheenTestGrid | extension | glTF,glTF-Binary
SheenWoodLeatherSofa | showcase,extension | glTF,glTF-Binary
SimpleInstancing | extension,testing | glTF,glTF-Binary
SimpleMaterial | core,testing,written | glTF,glTF-Embedded
SimpleMeshes | core,testing,written | glTF,glTF-Embedded
SimpleMorph | core,testing | glTF,glTF-Embedded
SimpleSkin | core,testing,written | glTF,glTF-Embedded
SimpleSparseAccessor | core,testing | glTF,glTF-Embedded
SimpleTexture | core,testing,written | glTF,glTF-Embedded
SpecGlossVsMetalRough | testing,extension | glTF,glTF-Binary
SpecularSilkPouf | showcase,extension | glTF,glTF-Binary
SpecularTest | testing,extension | glTF,glTF-Binary
Sponza | core | glTF
StainedGlassLamp | showcase,extension | glTF,glTF-JPG-PNG,glTF-KTX-BasisU
SunglassesKhronos | showcase,extension | glTF,glTF-Binary,glTF-Draco
Suzanne | core,testing | glTF
TextureCoordinateTest | core,testing | glTF,glTF-Binary,glTF-Embedded
TextureEncodingTest | core,testing | glTF,glTF-Binary
TextureLinearInterpolationTest | core,testing | glTF,glTF-Binary
TextureSettingsTest | core,testing | glTF,glTF-Binary,glTF-Embedded
TextureTransformMultiTest | testing,extension | glTF,glTF-Binary
TextureTransformTest | testing,extension | glTF
ToyCar | showcase,video,extension | glTF,glTF-Binary
TrafficCone | extension | glTF,glTF-Binary
TransmissionOrderTest | extension,testing | glTF,glTF-Binary
TransmissionRoughnessTest | testing,extension | glTF,glTF-Binary
TransmissionTest | testing,extension | glTF,glTF-Binary
TransmissionThinwallTestGrid | extension | glTF,glTF-Binary
Triangle | core,testing,written | glTF,glTF-Embedded
TriangleWithoutIndices | core,testing | glTF,glTF-Embedded
TwoSidedPlane | core | glTF
USDShaderBallForGltf | showcase,extension | glTF,glTF-Binary
Unicode❤♻Test | core,testing | glTF,glTF-Binary
UnlitTest | testing,extension | glTF,glTF-Binary
VertexColorTest | core,testing | glTF,glTF-Binary,glTF-Embedded
VirtualCity | core,testing | glTF,glTF-Binary,glTF-Draco,glTF-Embedded
WaterBottle | core,testing,written | glTF,glTF-Binary,glTF-Draco
XmpMetadataRoundedCube | extension,testing | glTF,glTF-Binary
`;

/** model-index.json entries (label = name, files named after the model). */
export const KHRONOS_REAL_INDEX = INDEX_TABLE.trim()
  .split('\n')
  .map((line) => {
    const [name, tags, variants] = line.split('|').map((s) => s.trim());
    return {
      label: name,
      name,
      screenshot: 'screenshot/screenshot.jpg',
      tags: tags ? tags.split(',') : [],
      variants: Object.fromEntries(
        variants.split(',').map((v) => [v, `${name}.${v.startsWith('glTF-Binary') ? 'glb' : 'gltf'}`]),
      ),
    };
  });

/** Models/CarConcept/metadata.json: a CC BY model with two Khronos logos (trademark notices). */
export const KHRONOS_CAR_CONCEPT_META = {
  version: 2,
  legal: [
    {
      license: 'CC-BY-4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/legalcode',
      artist: 'Eric Chadwick',
      year: '2024',
      owner: 'Darmstadt Graphics Group GmbH',
      what: 'Model and textures',
      text: 'Creative Commons Attribution 4.0 International',
      spdx: 'CC-BY-4.0',
    },
    {
      license: 'LicenseRef-LegalMark-Khronos',
      licenseUrl: '../../LICENSES/LicenseRef-LegalMark-Khronos.txt',
      artist: 'Non-copyrightable logo',
      year: '2015',
      owner: 'Khronos Group',
      what: 'Khronos logo',
      text: 'Khronos Trademark or Logo',
    },
    {
      license: 'LicenseRef-LegalMark-Khronos',
      licenseUrl: '../../LICENSES/LicenseRef-LegalMark-Khronos.txt',
      artist: 'Non-copyrightable logo',
      year: '2017',
      owner: 'Khronos Group',
      what: '3D Commerce logo',
      text: 'Khronos Trademark or Logo',
    },
  ],
  tags: ['showcase', 'extension'],
  screenshot: 'screenshot/screenshot.jpg',
  name: 'Car Concept',
  path: './Models/CarConcept',
  summary: 'Concept car with Khronos logos and material variants',
};

/** Models/DragonAttenuation/metadata.json: licences linked relative to the file. */
export const KHRONOS_DRAGON_META = {
  version: 2,
  legal: [
    {
      license: 'LicenseRef-Stanford-Graphics',
      licenseUrl: '../../LICENSES/LicenseRef-Stanford-Graphics.txt',
      artist: 'Stanford University Computer Graphics Laboratory',
      year: '1996',
      owner: 'Stanford University Computer Graphics Laboratory',
      what: 'Original dragon model',
      text: 'Stanford Graphics Library',
    },
    {
      license: 'LicenseRef-Stanford-Graphics',
      licenseUrl: '../../LICENSES/LicenseRef-Stanford-Graphics.txt',
      artist: "Morgan McGuire's Computer Graphics Archive",
      year: '2017',
      owner: 'Morgan McGuire',
      what: 'Conversion and clean up',
      text: 'Stanford Graphics Library',
    },
    {
      license: 'CC0-1.0',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode',
      artist: 'Adobe',
      year: '2021',
      owner: 'Public',
      what: 'Cloth backdrop',
      text: 'Creative Commons Zero v1.0 Universal',
      spdx: 'CC0-1.0',
    },
  ],
  tags: ['extension'],
  screenshot: 'screenshot/screenshot.jpg',
  name: 'Dragon Attenuation',
  path: './Models/DragonAttenuation',
  summary: 'Dragon with background, using material variants, transmission, and volume.',
};
