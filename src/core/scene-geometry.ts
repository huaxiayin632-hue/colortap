import type { Note, Project } from '../shared/models';
import { CameraEvaluator, cameraMatrix } from './camera';
import { RevealEvaluator, type RevealEvaluation } from './reveal';
import { PathBindings, identityMatrix } from './path-binding';
import type { PlaybackTake } from './playback';

/** Music-time geometry shared by authoring, rendering and moving-target judgement. */
export class SceneGeometry {
  readonly bindings: PathBindings;
  readonly camera: CameraEvaluator;
  readonly reveals: RevealEvaluator;
  constructor(readonly project: Project) {
    this.bindings = new PathBindings(project);
    this.camera = new CameraEvaluator(project);
    this.reveals = new RevealEvaluator(project);
  }
  at(
    timeUs: number,
    mode: RevealEvaluation['mode'],
    take?: PlaybackTake,
    sourceOnly = false,
    override?: RevealEvaluation['override'],
    layerIds?: Iterable<string>,
  ) {
    return {
      camera: cameraMatrix(this.project, this.camera.at(timeUs)),
      poses: sourceOnly ? {} : this.reveals.poses(timeUs, { mode, take, override }, layerIds),
    };
  }
  display(
    note: Note,
    timeUs: number,
    mode: RevealEvaluation['mode'],
    take?: PlaybackTake,
    sourceOnly = false,
    override?: RevealEvaluation['override'],
  ) {
    if (note.kind !== 'slider' || !note.binding) return identityMatrix();
    const { camera, poses } = this.at(
      timeUs,
      mode,
      take,
      sourceOnly,
      override,
      this.bindings.layersFor([note]),
    );
    return this.bindings.display(note, camera, poses);
  }
}
