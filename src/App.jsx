import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import {
  collection, doc, onSnapshot, query, where, updateDoc,
  serverTimestamp, setDoc, runTransaction
} from 'firebase/firestore';
import { auth, db } from './firebase';
import './App.css';

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');
const plates = ['91-060-12','91-363-12','50-80-570','32-177-72','85-370-52','29-947-76','659-40-101'];

const errorMessage = (e) => ({
  'auth/invalid-credential':'الإيميل أو كلمة المرور غير صحيحة',
  'permission-denied':'لا توجد صلاحية لتنفيذ العملية',
  'auth/too-many-requests':'محاولات كثيرة، حاول لاحقًا',
  'already-exists':'هذه الشاحنة محجوزة حالياً من موظف آخر'
})[e?.code] || e?.message || 'حدث خطأ غير متوقع';

function formatDate(v) {
  return v?.toDate?.()?.toLocaleString('ar-IL') || '—';
}

function validLocation(location) {
  return location &&
    Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude) &&
    Math.abs(location.latitude) <= 90 &&
    Math.abs(location.longitude) <= 180;
}

export default function App() {
  const [user,setUser] = useState(undefined);
  const [profile,setProfile] = useState(null);
  const [email,setEmail] = useState('');
  const [password,setPassword] = useState('');
  const [phone,setPhone] = useState('');
  const [workerPassword,setWorkerPassword] = useState('');
  const [error,setError] = useState('');
  const [trucks,setTrucks] = useState([]);
  const [shifts,setShifts] = useState([]);
  const [workers,setWorkers] = useState([]);
  const [selected,setSelected] = useState('');
  const [busy,setBusy] = useState(false);
  const [newPlate,setNewPlate] = useState('');
  const [newWorkerName,setNewWorkerName] = useState('');
  const [newWorkerUid,setNewWorkerUid] = useState('');
  const [reportFrom,setReportFrom] = useState('');
  const [reportTo,setReportTo] = useState('');
  const [reportWorker,setReportWorker] = useState('all');
  const [mapMessage,setMapMessage] = useState('يتم تحميل الخريطة...');
  const [mapRevision,setMapRevision] = useState(0);

  const gpsWatcherRef = useRef(null);
  const endingShiftRef = useRef(null);
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markerLayerRef = useRef(null);

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  useEffect(() => {
    if(!user) { setProfile(null); return; }
    return onSnapshot(doc(db,'users',user.uid), snapshot => {
      setProfile(snapshot.exists() ? snapshot.data() : null);
      setError('');
    }, e => setError(errorMessage(e)));
  },[user]);

  const isAdmin = profile?.role === 'admin';

  useEffect(() => {
    if(!user || !profile) return;
    const unsub = [];
    unsub.push(onSnapshot(collection(db,'trucks'), snapshot =>
      setTrucks(snapshot.docs.map(d => ({id:d.id,...d.data()}))),
      e => setError(errorMessage(e))
    ));
    const shiftsQuery = isAdmin
      ? collection(db,'shifts')
      : query(collection(db,'shifts'),where('uid','==',user.uid));
    unsub.push(onSnapshot(shiftsQuery, snapshot =>
      setShifts(snapshot.docs.map(d => ({id:d.id,...d.data()}))),
      e => setError(errorMessage(e))
    ));
    if(isAdmin) {
      unsub.push(onSnapshot(collection(db,'users'), snapshot =>
        setWorkers(snapshot.docs.map(d => ({id:d.id,...d.data()}))),
        e => setError(errorMessage(e))
      ));
    }
    return () => unsub.forEach(fn => fn());
  },[user,profile?.role,isAdmin]);

  const active = useMemo(
    () => shifts.find(s => s.uid === user?.uid && s.status === 'active'),
    [shifts,user]
  );

  const legacyMigrationRef = useRef(false);
  useEffect(() => {
    if(!isAdmin || !trucks.length || !shifts.length || legacyMigrationRef.current) return;
    legacyMigrationRef.current = true;
    const groups = new Map();
    shifts.filter(s => s.status === 'active' && s.truckId).forEach(s => {
      if(!groups.has(s.truckId)) groups.set(s.truckId,[]);
      groups.get(s.truckId).push(s);
    });
    (async () => {
      const conflicts = [];
      for(const [truckId,activeShifts] of groups.entries()) {
        const truck = trucks.find(t => t.id === truckId);
        if(!truck || truck.activeShiftId) continue;
        if(activeShifts.length !== 1) {
          conflicts.push(truckId);
          continue;
        }
        const legacyShift = activeShifts[0];
        await runTransaction(db,async transaction => {
          const truckRef = doc(db,'trucks',truckId);
          const shiftRef = doc(db,'shifts',legacyShift.id);
          const [truckSnapshot,shiftSnapshot] = await Promise.all([
            transaction.get(truckRef),transaction.get(shiftRef)
          ]);
          if(!truckSnapshot.exists() || !shiftSnapshot.exists()) return;
          const currentTruck = truckSnapshot.data();
          const currentShift = shiftSnapshot.data();
          if(currentShift.status !== 'active' || currentTruck.activeShiftId) return;
          transaction.update(truckRef,{
            activeShiftId:legacyShift.id,
            activeUid:legacyShift.uid,
            activeWorkerName:legacyShift.workerName || 'موظف',
            assignedAt:legacyShift.startedAt || serverTimestamp()
          });
        });
      }
      if(conflicts.length) {
        setError('تنبيه: توجد أكثر من وردية قديمة نشطة للشاحنة/الشاحنات: '+conflicts.join('، ')+'. أوقف التعارض يدوياً قبل السماح بحجزها.');
      }
    })().catch(e => {
      legacyMigrationRef.current = false;
      setError('تعذرت مزامنة حجوزات الورديات القديمة: '+errorMessage(e));
    });
  },[isAdmin,trucks,shifts]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try { await fn(); }
    catch(e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  const startGpsTracking = async (shiftId) => {
    if(!Capacitor.isNativePlatform()) {
      throw new Error('تتبع GPS بالخلفية يحتاج تطبيق الهاتف المثبّت، وليس المتصفح');
    }
    if(gpsWatcherRef.current?.shiftId === shiftId) return;
    if(gpsWatcherRef.current?.id) {
      await BackgroundGeolocation.removeWatcher({id:gpsWatcherRef.current.id});
      gpsWatcherRef.current = null;
    }

    const watcherId = await BackgroundGeolocation.addWatcher({
      backgroundMessage:'يتم إرسال موقعك إلى إدارة نقليات الصياد طوال فترة الدوام',
      backgroundTitle:'نقليات الصياد - تتبع الموقع',
      requestPermissions:true,
      stale:false,
      distanceFilter:25
    }, async (position,gpsError) => {
      if(gpsError || !position) {
        console.error('Background GPS:',gpsError);
        return;
      }
      if(position.simulated) {
        console.warn('تم تجاهل موقع GPS تجريبي');
        return;
      }
      try {
        await updateDoc(doc(db,'shifts',shiftId),{
          lastLocation:{
            latitude:position.latitude,
            longitude:position.longitude,
            accuracy:position.accuracy ?? null,
            speed:position.speed ?? null,
            bearing:position.bearing ?? null,
            time:position.time ?? Date.now(),
            updatedAt:serverTimestamp()
          }
        });
      } catch(e) {
        console.error('تعذر حفظ موقع GPS في Firebase:',e);
      }
    });

    gpsWatcherRef.current = {id:watcherId,shiftId};
  };

  const finishShiftTransaction = async (shift) => {
    const shiftRef = doc(db,'shifts',shift.id);
    const truckRef = doc(db,'trucks',shift.truckId);
    await runTransaction(db,async transaction => {
      const shiftSnapshot = await transaction.get(shiftRef);
      const truckSnapshot = await transaction.get(truckRef);
      if(!shiftSnapshot.exists()) throw new Error('سجل الدوام غير موجود');
      const current = shiftSnapshot.data();
      if(current.uid !== user.uid && !isAdmin) throw new Error('لا يمكنك إنهاء دوام موظف آخر');
      if(current.status !== 'active') return;
      transaction.update(shiftRef,{
        status:'done',
        endedAt:serverTimestamp()
      });
      if(truckSnapshot.exists() && truckSnapshot.data().activeShiftId === shift.id) {
        transaction.update(truckRef,{
          activeShiftId:null,
          activeUid:null,
          activeWorkerName:null,
          assignedAt:null
        });
      }
    });
  };

  const login = e => {
    e.preventDefault();
    run(() => signInWithEmailAndPassword(auth,email.trim(),password));
  };

  const workerLogin = e => {
    e.preventDefault();
    run(async () => {
      const digits = phone.replace(/\D/g,'');
      const local = digits.startsWith('972') ? '0'+digits.slice(3) : digits;
      if(!/^05[0-9]{8}$/.test(local)) throw new Error('أدخل رقم هاتف صحيحاً مثل 05XXXXXXXX');
      const accountEmail = 'driver' + local.slice(1) + '@al-sayyad-transport.firebaseapp.com';
      await signInWithEmailAndPassword(auth,accountEmail,workerPassword);
    });
  };

  const start = () => run(async () => {
    if(!selected) throw new Error('اختار الشاحنة أولاً');
    if(active) throw new Error('عندك دوام مفتوح');
    if(!Capacitor.isNativePlatform()) throw new Error('لتسجيل الدوام مع GPS استخدم تطبيق الهاتف المثبّت');
    const truckRef = doc(db,'trucks',selected);
    const shiftRef = doc(collection(db,'shifts'));
    await runTransaction(db,async transaction => {
      const truckSnapshot = await transaction.get(truckRef);
      if(!truckSnapshot.exists()) throw new Error('الشاحنة غير موجودة');
      const truck = truckSnapshot.data();
      if(truck.active === false) throw new Error('هذه الشاحنة غير متاحة');
      if(truck.activeShiftId) throw new Error('هذه الشاحنة مستخدمة حالياً من موظف آخر');
      transaction.set(shiftRef,{
        shiftId:shiftRef.id,
        uid:user.uid,
        workerName:profile.name || user.email,
        truckId:selected,
        status:'active',
        startedAt:serverTimestamp()
      });
      transaction.update(truckRef,{
        activeShiftId:shiftRef.id,
        activeUid:user.uid,
        activeWorkerName:profile.name || user.email,
        assignedAt:serverTimestamp()
      });
    });

    try {
      await startGpsTracking(shiftRef.id);
    } catch(gpsError) {
      await finishShiftTransaction({id:shiftRef.id,truckId:selected,uid:user.uid});
      throw new Error('لم يبدأ GPS، لذلك ألغينا حجز الشاحنة والدوام: '+(gpsError?.message || 'تحقق من صلاحية الموقع'));
    }
  });

  const stop = () => run(async () => {
    if(!active) return;
    endingShiftRef.current = active.id;
    await finishShiftTransaction(active);
    if(gpsWatcherRef.current?.id) {
      try {
        await BackgroundGeolocation.removeWatcher({id:gpsWatcherRef.current.id});
      } catch(removeError) {
        console.warn('تعذر إيقاف مراقب GPS محلياً؛ ستمنع قواعد Firebase تحديث سجل الدوام المنتهي.',removeError);
      } finally {
        gpsWatcherRef.current = null;
      }
    }
    setMapRevision(v => v+1);
  });

  // Re-attach the native location watcher when an employee reopens the app during an active shift.
  useEffect(() => {
    if(!user || !profile || !active || !Capacitor.isNativePlatform()) {
      if(!active) endingShiftRef.current = null;
      return;
    }
    if(endingShiftRef.current === active.id) return;
    if(gpsWatcherRef.current?.shiftId === active.id) return;
    let cancelled = false;
    startGpsTracking(active.id).catch(e => {
      if(!cancelled) setError('الدوام مفتوح لكن تعذّر استئناف GPS: '+(e?.message || 'تحقق من صلاحيات الموقع'));
    });
    return () => { cancelled = true; };
  },[user,profile,active?.id]);

  // Leaflet / OpenStreetMap live fleet map for administrators.
  useEffect(() => {
    if(!isAdmin || !mapContainerRef.current) return;
    const L = window.L;
    if(!L) {
      setMapMessage('تعذّر تحميل الخريطة. تحقق من اتصال الإنترنت.');
      return;
    }
    if(!mapRef.current) {
      mapRef.current = L.map(mapContainerRef.current,{scrollWheelZoom:true}).setView([31.5,34.9],7);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
        maxZoom:19,
        attribution:'&copy; OpenStreetMap'
      }).addTo(mapRef.current);
      markerLayerRef.current = L.layerGroup().addTo(mapRef.current);
    }
    markerLayerRef.current.clearLayers();
    const located = shifts.filter(s => s.status === 'active' && validLocation(s.lastLocation));
    located.forEach(s => {
      const p = s.lastLocation;
      const marker = L.marker([p.latitude,p.longitude]);
      const popup = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${s.workerName || s.uid} — ${s.truckId || 'شاحنة'}`;
      const detail = document.createElement('div');
      detail.textContent = `دقة GPS: ${p.accuracy ?? 'غير معروفة'} متر · آخر تحديث: ${p.time ? new Date(p.time).toLocaleString('ar-IL') : '—'}`;
      popup.append(title,detail);
      marker.bindPopup(popup);
      marker.addTo(markerLayerRef.current);
    });
    if(located.length) {
      const bounds = L.latLngBounds(located.map(s => [s.lastLocation.latitude,s.lastLocation.longitude]));
      mapRef.current.fitBounds(bounds.pad(0.25),{maxZoom:13});
    }
    setMapMessage(located.length ? `يظهر على الخريطة ${located.length} موقع نشط` : 'لا توجد مواقع GPS مستلمة بعد. يجب أن يبدأ الموظف الدوام من تطبيق الهاتف ويمنح صلاحية الموقع.');
    const timer = setTimeout(() => mapRef.current?.invalidateSize(),250);
    return () => clearTimeout(timer);
  },[isAdmin,shifts,mapRevision]);

  useEffect(() => () => {
    // Do not stop the native watcher on UI teardown: the native location
    // service must remain active while the app is backgrounded.
    if(mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }
  },[]);

  const addTruck = () => run(async () => {
    const plate = newPlate.trim();
    if(!plate) throw new Error('اكتب رقم الشاحنة');
    await setDoc(doc(db,'trucks',plate),{
      plate,active:true,activeShiftId:null,activeUid:null,activeWorkerName:null,assignedAt:null
    },{merge:true});
    setNewPlate('');
  });

  const addWorker = () => run(async () => {
    const uid = newWorkerUid.trim();
    const name = newWorkerName.trim();
    if(!uid || !name) throw new Error('أدخل الاسم وUID');
    await setDoc(doc(db,'users',uid),{name,role:'worker'});
    setNewWorkerName('');
    setNewWorkerUid('');
  });

  const reportRows = useMemo(() => {
    const from = reportFrom ? new Date(reportFrom+'T00:00:00').getTime() : -Infinity;
    const to = reportTo ? new Date(reportTo+'T23:59:59.999').getTime() : Infinity;
    return shifts.filter(s => {
      const startMs = s.startedAt?.toDate?.()?.getTime();
      return startMs && startMs >= from && startMs <= to &&
        (reportWorker === 'all' || s.uid === reportWorker);
    }).map(s => {
      const startDate = s.startedAt.toDate();
      const endDate = s.endedAt?.toDate?.() || new Date();
      return {
        ...s,
        reportMinutes:Math.max(0,Math.floor((endDate-startDate)/60000)),
        reportStart:startDate,
        reportEnd:s.endedAt?.toDate?.()
      };
    });
  },[shifts,reportFrom,reportTo,reportWorker]);

  const reportGroups = useMemo(() => {
    const groups = {};
    reportRows.forEach(s => {
      const key = s.uid || s.workerName || 'unknown';
      if(!groups[key]) groups[key] = {
        uid:key,
        name:s.workerName || workers.find(w => w.id === key)?.name || key,
        count:0,minutes:0
      };
      groups[key].count++;
      groups[key].minutes += s.reportMinutes;
    });
    return Object.values(groups).sort((a,b) => a.name.localeCompare(b.name,'ar'));
  },[reportRows,workers]);

  const reportTotal = reportRows.reduce((n,s) => n+s.reportMinutes,0);
  const reportHours = n => `${Math.floor(n/60)} ساعة و ${n%60} دقيقة`;
  const printReport = () => window.print();

  if(user === undefined) return <main className="wrap">جاري التحميل...</main>;

  if(!user) return <main className="wrap">
    <section className="panel login" dir="rtl">
      <h1>🚛 نقليات الصياد</h1>
      <p>تسجيل الدخول إلى النظام</p>
      <div className="inline">
        <button type="button" className="secondary" onClick={() => setError('')}>دخول الموظف</button>
      </div>
      <form onSubmit={workerLogin}>
        <input type="tel" dir="ltr" placeholder="رقم الهاتف 05XXXXXXXX" value={phone}
          onChange={e => setPhone(e.target.value)} required/>
        <input type="password" placeholder="كلمة مرور الموظف" value={workerPassword}
          onChange={e => setWorkerPassword(e.target.value)} required/>
        <button disabled={busy}>دخول الموظف</button>
      </form>
      <hr/>
      <h3>دخول المدير</h3>
      <form onSubmit={login}>
        <input type="email" placeholder="البريد الإلكتروني" value={email}
          onChange={e => setEmail(e.target.value)} required/>
        <input type="password" placeholder="كلمة المرور" value={password}
          onChange={e => setPassword(e.target.value)} required/>
        <button disabled={busy}>دخول المدير</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  </main>;

  if(!profile) return <main className="wrap"><section className="panel">
    <h2>الحساب غير مفعّل</h2>
    <p>تم تسجيل الدخول، لكن لا يوجد ملف صلاحيات لهذا الحساب في users/{user.uid}.</p>
    <p>UID: <code dir="ltr">{user.uid}</code></p>
    <p>يجب على مسؤول Firebase إنشاء مستند المستخدم وتحديد role = admin أو worker.</p>
    <button onClick={() => signOut(auth)}>خروج</button>
    {error && <p className="error">{error}</p>}
  </section></main>;

  const activeLocations = shifts.filter(s => s.status === 'active' && validLocation(s.lastLocation));

  return <main className="wrap">
    <header>
      <div><h1>🚛 نقليات الصياد</h1><p>مرحبًا، {profile.name || user.email} · {isAdmin ? 'مدير' : 'موظف'}</p></div>
      <button className="secondary" disabled={!!active} title={active ? 'أنه الدوام أولاً' : 'تسجيل خروج'} onClick={() => signOut(auth)}>تسجيل خروج</button>
    </header>
    {error && <p className="error">{error}</p>}
    <div className="stats">
      <section className="panel"><strong>{trucks.length}</strong><span>شاحنة</span></section>
      {isAdmin && <section className="panel"><strong>{workers.filter(w => w.role === 'worker').length}</strong><span>موظف</span></section>}
      {isAdmin && <section className="panel"><strong>{shifts.filter(s => s.status === 'active').length}</strong><span>دوام نشط</span></section>}
      {isAdmin && <section className="panel"><strong>{activeLocations.length}</strong><span>موقع GPS مستلم</span></section>}
    </div>

    <section className="panel">
      <h2>الدوام اليومي</h2>
      {active ? <>
        <p>شاحنتك الحالية: <b>{active.truckId}</b></p>
        <p className="hint">حالة الموقع: {validLocation(active.lastLocation) ? `آخر تحديث ${formatDate({toDate:()=>new Date(active.lastLocation.time || Date.now())})}` : 'بانتظار أول إشارة GPS'}</p>
        <button disabled={busy} onClick={stop}>إنهاء الدوام</button>
      </> : <>
        <select value={selected} onChange={e => setSelected(e.target.value)}>
          <option value="">اختر شاحنة</option>
          {trucks.filter(t => t.active !== false && !t.activeShiftId).map(t =>
            <option key={t.id} value={t.id}>{t.plate || t.id}</option>
          )}
        </select>
        <button disabled={busy || !selected} onClick={start}>بدء الدوام مع GPS</button>
        <p className="hint">يتم حجز الشاحنة ذرياً حتى إنهاء الدوام، لمنع استخدامها من موظف آخر.</p>
      </>}
    </section>

    {isAdmin && <>
      <section className="panel">
        <h2>📍 خريطة الشاحنات المباشرة</h2>
        <div ref={mapContainerRef} className="fleet-map" aria-label="خريطة مواقع الشاحنات"/>
        <p className="hint">{mapMessage}</p>
        <div className="tableScroll">
          <table><thead><tr><th>الموظف</th><th>الشاحنة</th><th>آخر موقع</th><th>آخر تحديث</th></tr></thead>
            <tbody>
              {shifts.filter(s => s.status === 'active').map(s => <tr key={s.id}>
                <td>{s.workerName || s.uid}</td><td>{s.truckId}</td>
                <td>{validLocation(s.lastLocation) ? <a target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${s.lastLocation.latitude}&mlon=${s.lastLocation.longitude}#map=16/${s.lastLocation.latitude}/${s.lastLocation.longitude}`}>فتح الموقع</a> : 'بانتظار GPS'}</td>
                <td>{s.lastLocation?.time ? new Date(s.lastLocation.time).toLocaleString('ar-IL') : '—'}</td>
              </tr>)}
              {!shifts.some(s => s.status === 'active') && <tr><td colSpan="4">لا توجد ورديات نشطة</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>إدارة الشاحنات</h2>
        <div className="inline">
          <input placeholder="رقم الشاحنة" value={newPlate} onChange={e => setNewPlate(e.target.value)}/>
          <button disabled={busy} onClick={addTruck}>إضافة شاحنة</button>
        </div>
        <div className="tags">{trucks.map(t =>
          <span key={t.id}>{t.plate || t.id}{t.activeShiftId ? ' — محجوزة' : ' — متاحة'}</span>
        )}</div>
        {trucks.length === 0 && <p>لم تُضف شاحنات بعد. الأرقام الأولية المقترحة: {plates.join('، ')}</p>}
      </section>

      <section className="panel">
        <h2>إدارة الموظفين</h2>
        <p className="hint">أنشئ حساب الموظف أولاً من Firebase Authentication، ثم انسخ UID الخاص به وأضفه هنا.</p>
        <div className="inline">
          <input placeholder="اسم الموظف" value={newWorkerName} onChange={e => setNewWorkerName(e.target.value)}/>
          <input placeholder="UID من Authentication" value={newWorkerUid} onChange={e => setNewWorkerUid(e.target.value)}/>
          <button disabled={busy} onClick={addWorker}>إضافة موظف</button>
        </div>
        <ul>{workers.map(w => <li key={w.id}>{w.name || w.id} — {w.role === 'admin' ? 'مدير' : 'موظف'}</li>)}</ul>
      </section>

      <section className="panel report-panel" dir="rtl">
        <h2>🚛 تقارير ساعات العمل</h2>
        <p>نقليات الصياد — تقارير الدوام</p>
        <div className="report-controls">
          <label>من تاريخ <input type="date" value={reportFrom} onChange={e => setReportFrom(e.target.value)}/></label>
          <label>إلى تاريخ <input type="date" value={reportTo} onChange={e => setReportTo(e.target.value)}/></label>
          <label>الموظف للتقرير الفردي
            <select value={reportWorker} onChange={e => setReportWorker(e.target.value)}>
              <option value="all">جميع الموظفين</option>
              {workers.filter(w => w.role === 'worker').map(w =>
                <option key={w.id} value={w.id}>{w.name || w.id}</option>
              )}
            </select>
          </label>
        </div>
        <h3>التقرير الفردي</h3>
        <p>الموظف: {reportWorker === 'all' ? 'اختر موظفاً من القائمة' : workers.find(w => w.id === reportWorker)?.name || reportWorker}</p>
        <div className="tableScroll">
          <table><thead><tr><th>الموظف</th><th>التاريخ</th><th>الشاحنة</th><th>البداية</th><th>النهاية</th><th>المدة</th><th>الحالة</th></tr></thead>
            <tbody>
              {reportRows.filter(s => reportWorker !== 'all' && s.uid === reportWorker).map(s => <tr key={s.id}>
                <td>{s.workerName || s.uid}</td><td>{s.reportStart.toLocaleDateString('ar-IL')}</td><td>{s.truckId}</td>
                <td>{s.reportStart.toLocaleTimeString('ar-IL')}</td><td>{s.reportEnd?.toLocaleTimeString('ar-IL') || 'مفتوح'}</td>
                <td>{reportHours(s.reportMinutes)}</td><td>{s.status === 'active' ? 'مفتوح' : 'مكتمل'}</td>
              </tr>)}
              {reportWorker === 'all' && <tr><td colSpan="7">اختر موظفاً لعرض تقريره الفردي</td></tr>}
            </tbody>
          </table>
        </div>
        {reportWorker !== 'all' && <p><strong>مجموع ساعات الموظف: {reportHours(reportTotal)}</strong></p>}
        <h3>التقرير الإجمالي لجميع الموظفين</h3>
        <div className="tableScroll">
          <table><thead><tr><th>الموظف</th><th>عدد الورديات</th><th>مجموع الساعات</th></tr></thead>
            <tbody>
              {reportGroups.map(g => <tr key={g.uid}><td>{g.name}</td><td>{g.count}</td><td>{reportHours(g.minutes)}</td></tr>)}
              {reportGroups.length === 0 && <tr><td colSpan="3">لا توجد سجلات في الفترة المحددة</td></tr>}
            </tbody>
          </table>
        </div>
        <p><strong>إجمالي ساعات جميع الموظفين: {reportHours(reportRows.reduce((n,s) => n+s.reportMinutes,0))}</strong></p>
        <button className="no-print" onClick={printReport}>طباعة / حفظ PDF</button>
      </section>

      <section className="panel">
        <h2>سجل الدوام</h2>
        <div className="tableScroll">
          <table><thead><tr><th>الموظف</th><th>الشاحنة</th><th>البداية</th><th>النهاية</th><th>الحالة</th></tr></thead>
            <tbody>{shifts.map(s => <tr key={s.id}>
              <td>{s.workerName}</td><td>{s.truckId}</td><td>{formatDate(s.startedAt)}</td>
              <td>{formatDate(s.endedAt)}</td><td>{s.status === 'active' ? 'مفتوح' : 'مكتمل'}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>
    </>}
  </main>;
}
