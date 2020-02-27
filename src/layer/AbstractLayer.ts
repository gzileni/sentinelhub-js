import axios from 'axios';

import { GetMapParams, ApiType, Tile, PaginatedTiles, FlyoverInterval } from 'src/layer/const';
import { BBox } from 'src/bbox';
import { Dataset } from 'src/layer/dataset';
import { RequestConfig } from 'src/utils/axiosInterceptors';
import intersect from '@turf/intersect';
import area from '@turf/area';
import union from '@turf/union'; // @turf/union is missing types definitions, we supply them separately

import { Polygon, MultiPolygon, Feature } from '@turf/helpers';
import { CRS_EPSG4326 } from 'src/crs';

export class AbstractLayer {
  public title: string | null = null;
  public description: string | null = null;
  public readonly dataset: Dataset | null = null;

  public constructor(title: string | null = null, description: string | null = null) {
    this.title = title;
    this.description = description;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async getMap(params: GetMapParams, api: ApiType): Promise<Blob> {
    switch (api) {
      case ApiType.WMS:
        const url = this.getMapUrl(params, api);
        const requestConfig: RequestConfig = { responseType: 'blob', useCache: true };
        const response = await axios.get(url, requestConfig);
        return response.data;
      default:
        const className = this.constructor.name;
        throw new Error(`API type "${api}" not supported in ${className}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public getMapUrl(params: GetMapParams, api: ApiType): string {
    throw new Error('Not implemented');
  }

  public async findTiles(
    bbox: BBox, // eslint-disable-line @typescript-eslint/no-unused-vars
    fromTime: Date, // eslint-disable-line @typescript-eslint/no-unused-vars
    toTime: Date, // eslint-disable-line @typescript-eslint/no-unused-vars
    maxCount: number = 50, // eslint-disable-line @typescript-eslint/no-unused-vars
    offset: number = 0, // eslint-disable-line @typescript-eslint/no-unused-vars
  ): Promise<PaginatedTiles> {
    throw new Error('Not implemented yet');
  }

  public async findFlyovers(
    bbox: BBox,
    fromTime: Date,
    toTime: Date,
    maxFindTilesRequests: number = 50,
    tilesPerRequest: number = 50,
  ): Promise<FlyoverInterval[]> {
    if (!this.dataset || !this.dataset.orbitTimeMinutes) {
      throw new Error('Orbit time is needed for grouping tiles into flyovers.');
    }
    if (bbox.crs !== CRS_EPSG4326) {
      throw new Error('Currently, only EPSG:4326 in findFlyovers');
    }

    const orbitTimeMS = this.dataset.orbitTimeMinutes * 60 * 1000;
    const bboxGeometry: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [bbox.minX, bbox.minY],
          [bbox.maxX, bbox.minY],
          [bbox.maxX, bbox.maxY],
          [bbox.minX, bbox.maxY],
          [bbox.minX, bbox.minY],
        ],
      ],
    };

    let flyovers: FlyoverInterval[] = [];
    let flyoverIndex = 0;
    let currentFlyoverGeometry: Polygon | MultiPolygon | null = null;
    let nTilesInFlyover;
    let sumCloudCoverPercent;
    for (let i = 0; i < maxFindTilesRequests; i++) {
      // grab new batch of tiles:
      const { tiles, hasMore } = await this.findTiles(
        bbox,
        fromTime,
        toTime,
        tilesPerRequest,
        i * tilesPerRequest,
      );

      // apply each tile to the flyover to calculate coverage:
      for (let tileIndex = 0; tileIndex < tiles.length; tileIndex++) {
        // first tile ever? just add its info and continue:
        if (flyovers.length === 0) {
          flyovers[flyoverIndex] = {
            fromTime: tiles[tileIndex].sensingTime,
            toTime: tiles[tileIndex].sensingTime,
            coveragePercent: 0,
            meta: {},
          };
          currentFlyoverGeometry = this.deFeature(tiles[tileIndex].geometry);
          sumCloudCoverPercent = tiles[tileIndex].meta.cloudCoverPercent;
          nTilesInFlyover = 1;
          continue;
        }

        // append the tile to flyovers:
        const prevDateMS = flyovers[flyoverIndex].fromTime.getTime();
        const currDateMS = tiles[tileIndex].sensingTime.getTime();
        const diffMS = Math.abs(prevDateMS - currDateMS);
        if (diffMS > orbitTimeMS || !hasMore) {
          // finish the old flyover:
          try {
            flyovers[flyoverIndex].coveragePercent = this.calculateCoveragePercent(
              bboxGeometry,
              currentFlyoverGeometry,
            );
          } catch (err) {
            flyovers[flyoverIndex].coveragePercent = null;
          }
          if (sumCloudCoverPercent !== undefined) {
            flyovers[flyoverIndex].meta.averageCloudCoverPercent = sumCloudCoverPercent / nTilesInFlyover;
          }

          // and start a new one:
          if (diffMS > orbitTimeMS) {
            flyoverIndex++;
            flyovers[flyoverIndex] = {
              fromTime: tiles[tileIndex].sensingTime,
              toTime: tiles[tileIndex].sensingTime,
              coveragePercent: 0,
              meta: {},
            };
            currentFlyoverGeometry = this.deFeature(tiles[tileIndex].geometry);
            sumCloudCoverPercent = tiles[tileIndex].meta.cloudCoverPercent;
            nTilesInFlyover = 1;
          }
        } else {
          // the same flyover:
          flyovers[flyoverIndex].fromTime = tiles[tileIndex].sensingTime;
          currentFlyoverGeometry = this.deFeature(
            union(currentFlyoverGeometry, this.deFeature(tiles[tileIndex].geometry)),
          );
          sumCloudCoverPercent =
            sumCloudCoverPercent !== undefined
              ? sumCloudCoverPercent + tiles[tileIndex].meta.cloudCoverPercent
              : undefined;
          nTilesInFlyover++;
        }
      }

      // make sure we exit when there are no more tiles:
      if (!hasMore) {
        break;
      }
      if (i + 1 === maxFindTilesRequests) {
        throw new Error(
          `Could not fetch all the tiles in [${maxFindTilesRequests}] requests for [${tilesPerRequest}] tiles`,
        );
      }
    }
    return flyovers;
  }

  private calculateCoveragePercent(bboxGeometry: Polygon, flyoverGeometry: Polygon | MultiPolygon): number {
    let bboxedFlyoverGeometry;
    try {
      bboxedFlyoverGeometry = intersect(bboxGeometry, flyoverGeometry);
    } catch (ex) {
      console.error({ msg: 'Turf.js intersect() failed', ex, bboxGeometry, flyoverGeometry });
      throw ex;
    }
    try {
      const result = (area(bboxedFlyoverGeometry) / area(bboxGeometry)) * 100;
      return result;
    } catch (ex) {
      console.error({ msg: 'Turf.js area() division failed', ex, bboxedFlyoverGeometry, flyoverGeometry });
      throw ex;
    }
  }

  public async updateLayerFromServiceIfNeeded(): Promise<void> {}

  private deFeature(f: Feature<Polygon | MultiPolygon> | Polygon | MultiPolygon): Polygon | MultiPolygon {
    return f.type === 'Feature' ? (f as Feature<Polygon | MultiPolygon>).geometry : f;
  }
}
