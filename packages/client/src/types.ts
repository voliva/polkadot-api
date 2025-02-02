import {
  Descriptors,
  EventsFromDescriptors,
  QueryFromDescriptors,
  TxFromDescriptors,
} from "@polkadot-api/substrate-bindings"
import { StorageEntry } from "./storage"
import { TxClient } from "./tx"
import { EvClient } from "./event"

export type CreateTx = (
  publicKey: Uint8Array,
  callData: Uint8Array,
) => Promise<Uint8Array>
interface JsonRpcProvider {
  send: (message: string) => void
  createTx: CreateTx
  disconnect: () => void
}

export type Connect = (onMessage: (value: string) => void) => JsonRpcProvider

type StorageApi<
  A extends Record<
    string,
    Record<
      string,
      | {
          KeyArgs: Array<any>
          Value: any
          IsOptional: false | true
        }
      | unknown
    >
  >,
> = {
  [K in keyof A]: {
    [KK in keyof A[K]]: A[K][KK] extends {
      KeyArgs: Array<any>
      Value: any
      IsOptional: false | true
    }
      ? StorageEntry<
          A[K][KK]["KeyArgs"],
          A[K][KK]["IsOptional"] extends true
            ? A[K][KK]["Value"] | undefined
            : A[K][KK]["Value"]
        >
      : unknown
  }
}

type TxApi<A extends Record<string, Record<string, Array<any> | unknown>>> = {
  [K in keyof A]: {
    [KK in keyof A[K]]: A[K][KK] extends Array<any>
      ? TxClient<A[K][KK]>
      : unknown
  }
}

type EvApi<A extends Record<string, Record<string, any>>> = {
  [K in keyof A]: {
    [KK in keyof A[K]]: EvClient<A[K][KK]>
  }
}

export type CreateClient = <T extends Descriptors>(
  connect: Connect,
  descriptors: T,
) => {
  query: StorageApi<QueryFromDescriptors<T>>
  tx: TxApi<TxFromDescriptors<T>>
  event: EvApi<EventsFromDescriptors<T>>
}
