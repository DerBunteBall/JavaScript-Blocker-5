"use strict";

var Snapshots = new Store('Snapshots', {
	save: true
});

function Snapshot (store, props) {
	if (!(store instanceof Store))
		throw new TypeError(store + ' is not an instance of Store');

	if (!(props instanceof Object))
		props = {};
	
	this.store = store;
	this.maxUnkept = (typeof props.maxUnkept === 'number') ? props.maxUnkept : 15;

	this.snapshots = Snapshots.getStore(this.store.name, {
		private: true
	});

	this.kept = this.snapshots.getStore('kept');
	this.unkept = this.snapshots.getStore('unkept');

	this.latestKept = this.__outerMost.bind(this, true, true);
	this.latestUnkept = this.__outerMost.bind(this, true, false);

	this.firstKept = this.__outerMost.bind(this, false, true);
	this.firstUnkept = this.__outerMost.bind(this, false, false);

	store.addEventListener('save', function () {
		Utilities.Timer.timeout('CheckForChanges' + this.snapshots.name, function (snapshot) {
			snapshot.checkForChanges();
		}, TIME.ONE_SECOND * 30, [this]);
	}.bind(this));
};

Snapshot.prototype.__outerMost = function (latest, kept, returnID) {
	var store = kept ? this.kept : this.unkept,
			ids = store.keys().sort();

	if (latest)
		ids.reverse();

	var snapshot = returnID ? ids[0] : store.get(ids[0]);

	if (!returnID && snapshot)
		snapshot.snapshot = Store.promote(snapshot.snapshot);

	return snapshot;
};

Snapshot.prototype.latest = function (returnID) {
	var latestKept = this.latestKept(true) || 0,
			latestUnkept = this.latestUnkept(true) || 0;
	
	if (returnID)
		return Math.max(latestKept, latestUnkept);
	
	var snapshot = latestKept > latestUnkept ? this.kept.get(latestKept) : this.unkept.get(latestUnkept);

	if (snapshot)
		snapshot.snapshot = Store.promote(snapshot.snapshot);

	return snapshot;
};

Snapshot.prototype.first = function (returnID) {
	var firstKept = this.firstKept(true) || Date.now(),
			firstUnkept = this.firstUnkept(true) || Date.now();
	
	if (returnID)
		return Math.min(firstKept, firstUnkept);
	
	var snapshot = firstKept < firstUnkept ? this.kept.get(firstKept) : this.unkept.get(firstUnkept);

	if (snapshot)
		snapshot.snapshot = Store.promote(snapshot.snapshot);

	return snapshot;
};

Snapshot.prototype.cleanStore = function () {
	return Store.promote(this.store.readyJSON());
};

Snapshot.prototype.checkForChanges = function () {
	if (this.kept.isEmpty() && this.unkept.isEmpty())
		return this.add();

	var cleanStore = this.cleanStore();

	if (cleanStore.isEmpty())
		return;

	var comparison = Store.compare(cleanStore, this.latest().snapshot);

	if (!comparison.equal)		
		this.add();

	comparison.store.destroy(true);
};

Snapshot.prototype.keep = function (id) {
	var unkeptSnapshot = this.unkept.get(id),
			keptSnapshot = this.kept.get(id);

	if (!unkeptSnapshot || keptSnapshot)
		return null;

	this.kept.set(snapshot, unkeptSnapshot);
	this.unkept.remove(id);
};

Snapshot.prototype.unkeep = function (id) {
	var unkeptSnapshot = this.unkept.get(id),
			keptSnapshot = this.kept.get(id);

	if (unkeptSnapshot || !keptSnapshot)
		return null;

	this.unkept.set(snapshot, keptSnapshot);
	this.kept.remove(id);
};

Snapshot.prototype.add = function (keep, name) {
	if (typeof name !== 'string')
		name = null;

	var id = Date.now(),
			store = keep ? this.kept : this.unkept;

	var cloned = this.store.clone(null, {
		lock: true,
		private: true
	}).readyJSON();

	if (cloned.data._isEmpty())
		return;

	LogDebug('New snapshot: ' + id + '-' + name);

	store.set(id, {
		name: name,
		snapshot: cloned
	});

	if (this.unkept.keys().length > this.maxUnkept)
		this.unkept.remove(this.firstUnkept(true));
};
