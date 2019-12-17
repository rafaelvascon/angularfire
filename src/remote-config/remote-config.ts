import { Injectable, Inject, Optional, NgZone, InjectionToken, PLATFORM_ID } from '@angular/core';
import { Observable, concat, of, pipe, OperatorFunction } from 'rxjs';
import { map, switchMap, tap, shareReplay, distinctUntilChanged, filter, groupBy, mergeMap, scan, withLatestFrom, startWith, debounceTime } from 'rxjs/operators';
import { FirebaseAppConfig, FirebaseOptions, ɵlazySDKProxy, FIREBASE_OPTIONS, FIREBASE_APP_NAME } from '@angular/fire';
import { remoteConfig } from 'firebase/app';

export interface ConfigTemplate {[key:string]: string|number|boolean};

export const REMOTE_CONFIG_SETTINGS = new InjectionToken<remoteConfig.Settings>('angularfire2.remoteConfig.settings');
export const DEFAULT_CONFIG = new InjectionToken<ConfigTemplate>('angularfire2.remoteConfig.defaultConfig');

import { FirebaseRemoteConfig, _firebaseAppFactory, runOutsideAngular } from '@angular/fire';
import { isPlatformServer } from '@angular/common';

// SEMVER: once we move to Typescript 3.6 use `PromiseProxy<remoteConfig.RemoteConfig>` rather than hardcoding
type RemoteConfigProxy = {
  activate: () => Promise<boolean>;
  ensureInitialized: () => Promise<void>;
  fetch: () => Promise<void>;
  fetchAndActivate: () => Promise<boolean>;
  getAll: () => Promise<{[key:string]: remoteConfig.Value}>;
  getBoolean: (key:string) => Promise<boolean>;
  getNumber: (key:string) => Promise<number>;
  getString: (key:string) => Promise<string>;
  getValue: (key:string) => Promise<remoteConfig.Value>;
  setLogLevel: (logLevel: remoteConfig.LogLevel) => Promise<void>;
  settings: Promise<remoteConfig.Settings>;
  defaultConfig: Promise<{
      [key: string]: string | number | boolean;
  }>;
  fetchTimeMillis: Promise<number>;
  lastFetchStatus: Promise<remoteConfig.FetchStatus>;
};

export interface AngularFireRemoteConfig extends RemoteConfigProxy {};

// TODO export as implements Partial<...> so minor doesn't break us
export class Value implements remoteConfig.Value {
  asBoolean() { return ['1', 'true', 't', 'y', 'yes', 'on'].indexOf(this._value.toLowerCase()) > -1 }
  asString() { return this._value }
  asNumber() { return Number(this._value) || 0 }
  getSource() { return this._source; }
  constructor(public _source: remoteConfig.ValueSource, public _value: string) { }
}

// SEMVER use ConstructorParameters when we can support Typescript 3.6
export class Parameter extends Value {
  constructor(public key: string, public fetchTimeMillis: number, source: remoteConfig.ValueSource, value: string) {
    super(source, value);
  }
}

// If it's a Parameter array, test any, else test the individual Parameter
const filterTest = (fn: (param:Parameter) => boolean) => filter<Parameter|Parameter[]>(it => Array.isArray(it) ? it.some(fn) : fn(it))

// Allow the user to bypass the default values and wait till they get something from the server, even if it's a cached copy;
// if used in conjuntion with first() it will only fetch RC values from the server if they aren't cached locally
export const filterRemote = () => filterTest(p => p.getSource() === 'remote');

// filterFresh allows the developer to effectively set up a maximum cache time
export const filterFresh = (howRecentInMillis: number) => filterTest(p => p.fetchTimeMillis + howRecentInMillis >= new Date().getTime());

@Injectable()
export class AngularFireRemoteConfig {

  readonly changes:    Observable<Parameter>;
  readonly parameters: Observable<Parameter[]>;
  readonly numbers:    Observable<{[key:string]: number}>  & {[key:string]: Observable<number>};
  readonly booleans:   Observable<{[key:string]: boolean}> & {[key:string]: Observable<boolean>};
  readonly strings:    Observable<{[key:string]: string}>  & {[key:string]: Observable<string|undefined>};

  constructor(
    @Inject(FIREBASE_OPTIONS) options:FirebaseOptions,
    @Optional() @Inject(FIREBASE_APP_NAME) nameOrConfig:string|FirebaseAppConfig|null|undefined,
    @Optional() @Inject(REMOTE_CONFIG_SETTINGS) settings:remoteConfig.Settings|null,
    @Optional() @Inject(DEFAULT_CONFIG) defaultConfig:ConfigTemplate|null,
    @Inject(PLATFORM_ID) platformId:Object,
    private zone: NgZone
  ) {
    
    const remoteConfig$ = of(undefined).pipe(
      // @ts-ignore zapping in the UMD in the build script
      switchMap(() => zone.runOutsideAngular(() => import('firebase/remote-config'))),
      map(() => _firebaseAppFactory(options, zone, nameOrConfig)),
      // SEMVER no need to cast once we drop older Firebase
      map(app => <remoteConfig.RemoteConfig>app.remoteConfig()),
      tap(rc => {
        if (settings) { rc.settings = settings }
        // FYI we don't load the defaults into remote config, since we have our own implementation
        // see the comment on scanToParametersArray
      }),
      startWith(undefined),
      runOutsideAngular(zone),
      shareReplay({ bufferSize: 1, refCount: false })
    );

    const loadedRemoteConfig$ = remoteConfig$.pipe(
      filter<remoteConfig.RemoteConfig>(rc => !!rc)
    );

    let default$: Observable<{[key:string]: remoteConfig.Value}> = of(Object.keys(defaultConfig || {}).reduce(
      (c, k) => ({...c, [k]: new Value("default", defaultConfig![k].toString()) }), {}
    ));

    const existing$ = loadedRemoteConfig$.pipe(
      switchMap(rc => rc.activate().then(() => rc.getAll()))
    );

    const fresh$ = loadedRemoteConfig$.pipe(
      switchMap(rc => zone.runOutsideAngular(() => rc.fetchAndActivate().then(() => rc.getAll())))
    );

    this.parameters = concat(default$, existing$, fresh$).pipe(
      scanToParametersArray(remoteConfig$),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    this.changes = this.parameters.pipe(
      switchMap(params => of(...params)),
      groupBy(param => param.key),
      mergeMap(group => group.pipe(
        distinctUntilChanged()
      ))
    );

    this.strings  = proxyAll(this.parameters, 'strings');
    this.booleans = proxyAll(this.parameters, 'booleans');
    this.numbers  = proxyAll(this.parameters, 'numbers');

    // TODO fix the proxy for server
    return isPlatformServer(platformId) ? this : ɵlazySDKProxy(this, remoteConfig$, zone);
  }

}

// I ditched loading the defaults into RC and a simple map for scan since we already have our own defaults implementation.
// The idea here being that if they have a default that never loads from the server, they will be able to tell via fetchTimeMillis on the Parameter.
// Also if it doesn't come from the server it won't emit again in .changes, due to the distinctUntilChanged, which we can simplify to === rather than deep comparison
const scanToParametersArray = (remoteConfig: Observable<remoteConfig.RemoteConfig|undefined>): OperatorFunction<{[key:string]: remoteConfig.Value}, Parameter[]> => pipe(
  withLatestFrom(remoteConfig),
  scan((existing, [all, rc]) => {
    // SEMVER use "new Set" to unique once we're only targeting es6
    // at the scale we expect remote config to be at, we probably won't see a performance hit from this unoptimized uniqueness implementation
    // const allKeys = [...new Set([...existing.map(p => p.key), ...Object.keys(all)])];
    const allKeys = [...existing.map(p => p.key), ...Object.keys(all)].filter((v, i, a) => a.indexOf(v) === i);
    return allKeys.map(key => {
      const updatedValue = all[key];
      return updatedValue ? new Parameter(key, rc ? rc.fetchTimeMillis : -1, updatedValue.getSource(), updatedValue.asString())
                : existing.find(p => p.key === key)!
    });
  }, [] as Array<Parameter>)
);

const AS_TO_FN = { 'strings': 'asString', 'numbers': 'asNumber', 'booleans': 'asBoolean' };
const PROXY_DEFAULTS = { 'numbers': 0, 'booleans': false, 'strings': undefined };

export const budget = (interval: number) => <T>(source: Observable<T>) => new Observable<T>(observer => {
    let timedOut = false;
    // TODO use scheduler task rather than settimeout
    const timeout = setTimeout(() => {
      observer.complete();
      timedOut = true;
    }, interval);
    return source.subscribe({
      next(val) { if (!timedOut) { observer.next(val); } },
      error(err) { if (!timedOut) { clearTimeout(timeout); observer.error(err); } },
      complete() { if (!timedOut) { clearTimeout(timeout); observer.complete(); } }
    })
  });

const typedMethod = (it:any) => {
  switch(typeof it) {
    case 'string': return 'asString';
    case 'boolean': return 'asBoolean';
    case 'number': return 'asNumber';
    default: return 'asString';
  }
};

export function scanToObject(): OperatorFunction<Parameter, {[key:string]: string}>;
export function scanToObject(as: 'numbers'): OperatorFunction<Parameter, {[key:string]: number}>;
export function scanToObject(as: 'booleans'): OperatorFunction<Parameter, {[key:string]: boolean}>;
export function scanToObject(as: 'strings'): OperatorFunction<Parameter, {[key:string]: string}>;
export function scanToObject<T extends ConfigTemplate>(template: T): OperatorFunction<Parameter, T & {[key:string]: string|undefined}>;
export function scanToObject(as: 'numbers'|'booleans'|'strings'|ConfigTemplate = 'strings') {
  return pipe(
    // TODO cleanup
    scan((c, p: Parameter) => ({...c, [p.key]: typeof as === 'object' ? p[typedMethod(as[p.key])]() : p[AS_TO_FN[as]]()}), typeof as === 'object' ? as : {} as {[key:string]: number|boolean|string}),
    debounceTime(1),
    budget(10),
    distinctUntilChanged((a,b) => JSON.stringify(a) === JSON.stringify(b))
  );
};

export function mapToObject(): OperatorFunction<Parameter[], {[key:string]: string}>;
export function mapToObject(as: 'numbers'): OperatorFunction<Parameter[], {[key:string]: number}>;
export function mapToObject(as: 'booleans'): OperatorFunction<Parameter[], {[key:string]:  boolean}>;
export function mapToObject(as: 'strings'): OperatorFunction<Parameter[], {[key:string]: string}>;
export function mapToObject<T extends ConfigTemplate>(template: T): OperatorFunction<Parameter[], T & {[key:string]: string|undefined}>;
export function mapToObject(as: 'numbers'|'booleans'|'strings'|ConfigTemplate = 'strings') {
  return pipe(
    // TODO this is getting a little long, cleanup
    map((params: Parameter[]) => params.reduce((c, p) => ({...c, [p.key]: typeof as === 'object' ? p[typedMethod(as[p.key])]() : p[AS_TO_FN[as]]()}), typeof as === 'object' ? as : {} as {[key:string]: number|boolean|string})),
    distinctUntilChanged((a,b) => JSON.stringify(a) === JSON.stringify(b))
  );
};

// TODO look into the types here, I don't like the anys
const proxyAll = (observable: Observable<Parameter[]>, as: 'numbers'|'booleans'|'strings') => new Proxy(
  observable.pipe(mapToObject(as as any)), {
    get: (self, name:string) => self[name] || observable.pipe(
      map(all => all.find(p => p.key === name)),
      map(param => param ? param[AS_TO_FN[as]]() : PROXY_DEFAULTS[as]),
      distinctUntilChanged()
    )
  }
) as any;