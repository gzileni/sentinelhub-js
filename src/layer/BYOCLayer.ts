import { AxiosRequestConfig } from 'axios';
import moment from 'moment';
import axios from 'axios';

import { getAuthToken } from 'src/auth';
import { BBox } from 'src/bbox';
import {
  PaginatedTiles,
  LocationIdSHv3,
  SHV3_LOCATIONS_ROOT_URL,
  GetMapParams,
  ApiType,
  GetStatsParams,
  Stats,
} from 'src/layer/const';
import { DATASET_BYOC } from 'src/layer/dataset';
import { AbstractSentinelHubV3Layer } from 'src/layer/AbstractSentinelHubV3Layer';
import { ProcessingPayload } from 'src/layer/processing';
import { getAxiosReqParams, RequestConfiguration } from 'src/utils/cancelRequests';
import { ensureTimeout } from 'src/utils/ensureTimeout';

interface ConstructorParameters {
  instanceId?: string | null;
  layerId?: string | null;
  evalscript?: string | null;
  evalscriptUrl?: string | null;
  dataProduct?: string | null;
  title?: string | null;
  description?: string | null;
  collectionId?: string | null;
  locationId?: LocationIdSHv3 | null;
}

type BYOCFindTilesDatasetParameters = {
  type: string;
  collectionId: string;
};

export class BYOCLayer extends AbstractSentinelHubV3Layer {
  public readonly dataset = DATASET_BYOC;
  protected collectionId: string;
  protected locationId: LocationIdSHv3;

  public constructor({
    instanceId = null,
    layerId = null,
    evalscript = null,
    evalscriptUrl = null,
    dataProduct = null,
    title = null,
    description = null,
    collectionId = null,
    locationId = null,
  }: ConstructorParameters) {
    super({ instanceId, layerId, evalscript, evalscriptUrl, dataProduct, title, description });
    this.collectionId = collectionId;
    this.locationId = locationId;
  }

  public async updateLayerFromServiceIfNeeded(reqConfig?: RequestConfiguration): Promise<void> {
    await ensureTimeout(async innerConfig => {
      if (this.collectionId !== null && this.locationId !== null) {
        return;
      }

      if (this.instanceId === null || this.layerId === null) {
        throw new Error(
          "Some of layer parameters (collectionId, locationId) are not set and can't be fetched from service because instanceId and layerId are not available",
        );
      }

      if (this.collectionId === null) {
        const layerParams = await this.fetchLayerParamsFromSHServiceV3(innerConfig);
        this.collectionId = layerParams['collectionId'];
      }

      if (this.locationId === null) {
        const url = `https://services.sentinel-hub.com/api/v1/metadata/collection/CUSTOM/${this.collectionId}`;
        const headers = { Authorization: `Bearer ${getAuthToken()}` };
        const res = await axios.get(url, {
          responseType: 'json',
          headers: headers,
          useCache: true,
          ...getAxiosReqParams(innerConfig),
        });

        this.locationId = res.data.location.id;
      }
    }, reqConfig);
  }

  public async getMap(params: GetMapParams, api: ApiType, reqConfig?: RequestConfiguration): Promise<Blob> {
    const getMapValue = await ensureTimeout(async innerConfig => {
      await this.updateLayerFromServiceIfNeeded(innerConfig);
      return await super.getMap(params, api, innerConfig);
    }, reqConfig);
    return getMapValue;
  }

  protected async updateProcessingGetMapPayload(
    payload: ProcessingPayload,
    reqConfig: RequestConfiguration,
  ): Promise<ProcessingPayload> {
    const payloadValue = await ensureTimeout(async innerConfig => {
      await this.updateLayerFromServiceIfNeeded(innerConfig);
      payload.input.data[0].dataFilter.collectionId = this.collectionId;
      return payload;
    }, reqConfig);
    return payloadValue;
  }

  public async findTiles(
    bbox: BBox,
    fromTime: Date,
    toTime: Date,
    maxCount: number | null = null,
    offset: number | null = null,
    reqConfig?: RequestConfiguration,
  ): Promise<PaginatedTiles> {
    const tiles = await ensureTimeout(async innerConfig => {
      await this.updateLayerFromServiceIfNeeded(innerConfig);

      const findTilesDatasetParameters: BYOCFindTilesDatasetParameters = {
        type: 'BYOC',
        collectionId: this.collectionId,
      };
      // searchIndex URL depends on the locationId:
      const rootUrl = SHV3_LOCATIONS_ROOT_URL[this.locationId];
      const searchIndexUrl = `${rootUrl}byoc/v3/collections/CUSTOM/searchIndex`;
      const response = await this.fetchTiles(
        searchIndexUrl,
        bbox,
        fromTime,
        toTime,
        maxCount,
        offset,
        innerConfig,
        null,
        findTilesDatasetParameters,
      );
      return {
        tiles: response.data.tiles.map(tile => {
          return {
            geometry: tile.dataGeometry,
            sensingTime: moment.utc(tile.sensingTime).toDate(),
            meta: {
              cloudCoverPercent: tile.cloudCoverPercentage,
            },
          };
        }),
        hasMore: response.data.hasMore,
      };
    }, reqConfig);
    return tiles;
  }

  protected getShServiceHostname(): string {
    if (this.locationId === null) {
      throw new Error('Parameter locationId must be specified');
    }
    const shServiceHostname = SHV3_LOCATIONS_ROOT_URL[this.locationId];
    return shServiceHostname;
  }

  protected createSearchIndexRequestConfig(): AxiosRequestConfig {
    return {};
  }

  protected async getFindDatesUTCUrl(reqConfig: RequestConfiguration): Promise<string> {
    const datesUTCUrl = await ensureTimeout(async innerConfig => {
      await this.updateLayerFromServiceIfNeeded(innerConfig);
      const rootUrl = SHV3_LOCATIONS_ROOT_URL[this.locationId];
      const findDatesUTCUrl = `${rootUrl}byoc/v3/collections/CUSTOM/findAvailableData`;
      return findDatesUTCUrl;
    }, reqConfig);
    return datesUTCUrl;
  }

  protected async getFindDatesUTCAdditionalParameters(
    reqConfig: RequestConfiguration,
  ): Promise<Record<string, any>> {
    const parameters = await ensureTimeout(async innerConfig => {
      await this.updateLayerFromServiceIfNeeded(innerConfig);

      const result: Record<string, any> = {
        datasetParameters: {
          type: this.dataset.datasetParametersType,
          collectionId: this.collectionId,
        },
      };
      return result;
    }, reqConfig);
    return parameters;
  }

  public async getStats(params: GetStatsParams): Promise<Stats> {
    await this.updateLayerFromServiceIfNeeded();
    return super.getStats(params);
  }

  protected getConvertEvalscriptBaseUrl(): string {
    return `${super.getConvertEvalscriptBaseUrl()}&byocCollectionId=${this.collectionId}`;
  }

  public async getAvailableBands(reqConfig?: RequestConfiguration): Promise<void> {
    if (this.collectionId === null) {
      throw new Error('Parameter collectionId is not set');
    }
    const bandsResponseData = await ensureTimeout(async innerConfig => {
      const url = `https://services.sentinel-hub.com/api/v1/metadata/collection/CUSTOM/${this.collectionId}`;
      const headers = { Authorization: `Bearer ${getAuthToken()}` };
      const res = await axios.get(url, {
        responseType: 'json',
        headers: headers,
        useCache: true,
        ...getAxiosReqParams(innerConfig),
      });
      return res.data.bands;
    }, reqConfig);
    return bandsResponseData;
  }
}
