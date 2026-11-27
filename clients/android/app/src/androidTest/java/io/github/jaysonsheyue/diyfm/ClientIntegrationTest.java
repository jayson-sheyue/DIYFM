package io.github.jaysonsheyue.diyfm;

import android.content.Context;
import android.webkit.WebView;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.rule.ActivityTestRule;
import androidx.test.runner.AndroidJUnit4;
import org.junit.*;
import org.junit.runner.RunWith;
import org.json.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.junit.Assert.*;

/** Real Android storage/player integration. Synthetic tones, no model calls or private data. */
@RunWith(AndroidJUnit4.class)
public class ClientIntegrationTest {
    @Rule public ActivityTestRule<MainActivity> activity = new ActivityTestRule<>(MainActivity.class);
    interface Work {JSONObject run() throws Exception;}
    JSONObject main(Work work) throws Exception {
        AtomicReference<JSONObject> value=new AtomicReference<>();AtomicReference<Exception> error=new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{try{value.set(work.run());}catch(Exception e){error.set(e);}});
        if(error.get()!=null)throw error.get();return value.get();
    }
    PlaybackService service() throws Exception {
        for(int i=0;i<100;i++){if(PlaybackService.instance!=null)return PlaybackService.instance;Thread.sleep(100);}throw new AssertionError("Media service did not start");
    }
    JSONObject state() throws Exception {return main(()->service().state());}
    byte[] wav(int frequency) {
        int samples=24000;ByteBuffer out=ByteBuffer.allocate(44+samples*2).order(ByteOrder.LITTLE_ENDIAN);
        out.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(out.capacity()-8).put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short)1).putShort((short)1).putInt(24000).putInt(48000).putShort((short)2).putShort((short)16).put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples*2);
        for(int i=0;i<samples;i++)out.putShort((short)(7000*Math.sin(2*Math.PI*frequency*i/24000.0)+700*Math.sin(2*Math.PI*220*i/24000.0)));
        return out.array();
    }
    String save(NativeFiles files,int frequency) throws Exception {
        byte[] data=wav(frequency);StringBuilder key=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(data))key.append(String.format(Locale.ROOT,"%02x",b&255));
        JSONObject start=files.begin(new JSONObject().put("kind","media").put("id",key).put("size",data.length),null);
        if(!start.optBoolean("exists")){String ticket=start.getString("ticket");files.chunk(new JSONObject().put("ticket",ticket).put("offset",0).put("data",android.util.Base64.encodeToString(data,android.util.Base64.NO_WRAP)));files.commit(ticket);}
        return key.toString();
    }
    @Test public void nativeFilesValidateHashesOrderAndIncompleteWrites() throws Exception {
        NativeFiles files=new NativeFiles(activity.getActivity());String key=save(files,880);assertTrue(files.audio(key).isFile());
        byte[] bytes=wav(660);JSONObject begin=files.begin(new JSONObject().put("kind","media").put("id","a".repeat(64)).put("size",bytes.length),null);String ticket=begin.getString("ticket");
        try{files.chunk(new JSONObject().put("ticket",ticket).put("offset",1).put("data","AAAA"));fail("Out-of-order bytes accepted");}catch(Exception expected){}
        try{files.commit(ticket);fail("Incomplete transfer accepted");}catch(Exception expected){}
        files.chunk(new JSONObject().put("ticket",ticket).put("offset",0).put("data",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP)));
        try{files.commit(ticket);fail("Hash mismatch accepted");}catch(Exception expected){}
        files.abort(ticket);assertFalse(files.audio("a".repeat(64)).exists());assertTrue(files.audio(key).isFile());
    }
    @Test public void actualPlayerLoopsInBackgroundHonorsPauseAndRejectsOldIntents() throws Exception {
        NativeFiles files=new NativeFiles(activity.getActivity());String a=save(files,880),b=save(files,660);PlaybackService player=service();
        long revision=state().getLong("revision")+1;
        JSONArray tracks=new JSONArray().put(new JSONObject().put("id","qa_a").put("key",a).put("title","Synthetic A")).put(new JSONObject().put("id","qa_b").put("key",b).put("title","Synthetic B"));
        JSONObject load=new JSONObject().put("revision",revision).put("tracks",tracks).put("selected","qa_a").put("mode","channel").put("rate",1.0);
        main(()->player.route("player.load",load,files));
        boolean advanced=false;for(int i=0;i<80;i++){JSONObject s=state();if(s.optString("id").equals("qa_b")&&s.optDouble("time")>0){advanced=true;break;}Thread.sleep(100);}assertTrue("Real audio did not advance",advanced);
        main(()->{activity.getActivity().moveTaskToBack(true);return new JSONObject();});
        Thread.sleep(1400);assertFalse("Background service paused",state().getBoolean("paused"));assertTrue(state().getDouble("duration")>.9);
        java.lang.reflect.Field sessionField=PlaybackService.class.getDeclaredField("session");sessionField.setAccessible(true);
        androidx.media3.session.MediaSession session=(androidx.media3.session.MediaSession)sessionField.get(player);
        android.media.session.MediaController system=new android.media.session.MediaController(activity.getActivity(),session.getPlatformToken());
        assertNotNull("Notification cannot reopen the app",system.getSessionActivity());
        system.getTransportControls().pause();for(int i=0;i<30&&!state().getBoolean("paused");i++)Thread.sleep(100);assertTrue("Platform media pause failed",state().getBoolean("paused"));
        system.getTransportControls().seekTo(200);Thread.sleep(200);assertEquals(.2,state().getDouble("time"),.15);
        system.getTransportControls().play();for(int i=0;i<30&&state().getBoolean("paused");i++)Thread.sleep(100);assertFalse("Platform media resume failed",state().getBoolean("paused"));
        JSONObject pause=new JSONObject().put("revision",++revision);main(()->player.route("player.pause",pause,files));double position=state().getDouble("time");Thread.sleep(400);assertEquals(position,state().getDouble("time"),.1);
        JSONObject resume=new JSONObject().put("revision",++revision);main(()->player.route("player.play",resume,files));
        JSONObject config=new JSONObject().put("revision",revision).put("mode","single").put("rate",1.25);main(()->player.route("player.configure",config,files));String current=state().getString("id");Thread.sleep(1700);assertEquals(current,state().getString("id"));
        JSONObject stop=new JSONObject().put("revision",++revision);main(()->player.route("player.stop",stop,files));main(()->player.route("player.load",load,files));assertEquals("",state().getString("id"));assertTrue(state().getBoolean("paused"));
        main(()->{files.prune(player.activeKeys());return new JSONObject();});assertFalse(files.audio(a).exists());
    }
    @Test public void bundledFrontendStartsEnglishAndNativeBridgeWithoutNetwork() throws Exception {
        String upgrade=InstrumentationRegistry.getArguments().getString("upgradePhase");
        if(upgrade!=null){upgradeFixture(upgrade);return;}
        java.lang.reflect.Field field=MainActivity.class.getDeclaredField("web");field.setAccessible(true);WebView web=(WebView)field.get(activity.getActivity());
        waitDocument(web);
        String result="";
        for(int i=0;i<80;i++){
            CountDownLatch gate=new CountDownLatch(1);AtomicReference<String> value=new AtomicReference<>("");
            main(()->{web.evaluateJavascript("JSON.stringify({language:document.documentElement.lang,ready:!!document.querySelector('#make, #play-featured, [data-play]')?.textContent.trim(),native:!!window.DIYFM_NATIVE,version:window.DIYFM_NATIVE?.info.version})",v->{value.set(v);gate.countDown();});return new JSONObject();});
            assertTrue("WebView DOM callback timed out after document commit",gate.await(5,TimeUnit.SECONDS));result=value.get();if(result.contains(BuildConfig.VERSION_NAME)&&result.contains("true"))break;Thread.sleep(100);
        }
        assertTrue(result,result.contains("en"));assertTrue(result,result.contains(BuildConfig.VERSION_NAME));assertTrue(result,result.contains("true"));
        String starterCheck="window.__starterQA=null;(async()=>{const api=window.DIYFM;await api.ready;const before=(await(await api.fetch('/api/shows')).json()).shows.length;const en=await api.featured('en'),ja=await api.featured('ja');const audio=await(await fetch(ja.url)).blob();const after=(await(await api.fetch('/api/shows')).json()).shows.length;window.__starterQA={hasEn:en.language==='en'&&en.script.includes('Host:'),hasJa:ja.language==='ja'&&ja.script.includes('Host:'),savedUnchanged:before===after,audioBytes:audio.size};})().catch(e=>window.__starterQA={error:e.message});";
        main(()->{web.evaluateJavascript(starterCheck,null);return new JSONObject();});
        String starterRaw="null";for(int i=0;i<150;i++){starterRaw=readJS(web,"window.__starterQA");if(!starterRaw.equals("null"))break;Thread.sleep(100);}
        JSONObject starters=new JSONObject(starterRaw);assertFalse(starters.toString(),starters.has("error"));
        assertTrue(starters.toString(),starters.getBoolean("hasEn"));assertTrue(starters.toString(),starters.getBoolean("hasJa"));assertTrue(starters.toString(),starters.getBoolean("savedUnchanged"));assertTrue(starters.getInt("audioBytes")>44);
    }

    @Test public void homepageSamplesPlayThroughNativePlayerAndFollowSentences() throws Exception {
        java.lang.reflect.Field field=MainActivity.class.getDeclaredField("web");field.setAccessible(true);WebView web=(WebView)field.get(activity.getActivity());
        waitDocument(web);
        for(int i=0;i<100;i++){if(readJS(web,"!!window.DIYFM && !!document.querySelector('#ui-language')").equals("true"))break;Thread.sleep(100);}
        String ui="window.__featuredQA=null;(async()=>{const $=id=>document.getElementById(id);const check=(ok,msg)=>{if(!ok)throw Error(msg)};const wait=async fn=>{for(let i=0;i<180;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100))}throw Error('Timed out waiting for sample playback')};await window.DIYFM.ready;$('new-channel').click();$('back-home').click();window.__featuredPhase='load English';await wait(()=>$('play-featured')?.dataset.play==='featured_en');const play=$('play-featured').getBoundingClientRect(),nav=document.querySelector('.dock-nav').getBoundingClientRect();check(play.bottom<nav.top,'Homepage play is below the fold');check(document.querySelector('details.transcript').open,'Transcript starts collapsed');$('play-featured').click();window.__featuredPhase='play English';await wait(async()=>{const s=await window.DIYFM_NATIVE.bridge.request('player.state');return s.id==='featured_en'&&!s.paused&&s.time>0});window.__featuredPhase='highlight';await wait(()=>document.querySelector('.transcript-sentence.is-current'));document.querySelector('[data-reader]').dispatchEvent(new WheelEvent('wheel',{deltaY:100}));check(document.querySelector('[data-reader-follow]').textContent.includes('Back'),'Manual browsing did not suspend following');document.querySelector('[data-reader-follow]').click();$('play-featured').click();window.__featuredPhase='pause';await wait(async()=>(await window.DIYFM_NATIVE.bridge.request('player.state')).paused);check(!!document.querySelector('.transcript-sentence.is-current'),'Pause cleared highlight');document.querySelector('[data-featured-language=ja]').click();window.__featuredPhase='load Japanese';await wait(()=>$('play-featured')?.dataset.play==='featured_ja');$('play-featured').click();window.__featuredPhase='play Japanese';await wait(async()=>{const s=await window.DIYFM_NATIVE.bridge.request('player.state');return s.id==='featured_ja'&&!s.paused&&s.time>0});window.__featuredPhase='highlight';await wait(()=>document.querySelector('.transcript-sentence.is-current'));const seek=document.querySelector('.native-audio input');window.__featuredPhase='seek readiness';await wait(()=>!seek.disabled&&Number(seek.max)>50);seek.value='50';seek.dispatchEvent(new Event('change'));window.__featuredPhase='seek';await wait(async()=>(await window.DIYFM_NATIVE.bridge.request('player.state')).time>49);$('stop-player').click();window.__featuredQA={ok:true,playBottom:play.bottom,navTop:nav.top};})().catch(e=>window.__featuredQA={error:e.message,phase:window.__featuredPhase,notice:document.getElementById('status-text').textContent});";
        main(()->{web.evaluateJavascript(ui,null);return new JSONObject();});
        String raw="null";for(int i=0;i<500;i++){raw=readJS(web,"window.__featuredQA");if(!raw.equals("null"))break;Thread.sleep(100);}
        JSONObject result=new JSONObject(raw);assertFalse(result.toString(),result.has("error"));assertTrue(result.toString(),result.getBoolean("ok"));
        android.util.Log.i("DIYFM_QA","Homepage native sample/highlight verification: "+result);
    }

    @Test public void channelPackagePreviewCommitAndReexportKeepNativeReadableAudio() throws Exception {
        java.lang.reflect.Field field=MainActivity.class.getDeclaredField("web");field.setAccessible(true);WebView web=(WebView)field.get(activity.getActivity());
        waitDocument(web);
        for(int i=0;i<100;i++){if(readJS(web,"!!window.DIYFM_NATIVE && !!window.DIYFM").equals("true"))break;Thread.sleep(100);}
        JSONObject ep=new JSONObject().put("id","qa_share_audio").put("title","Synthetic sharing tone").put("status","ready").put("duration_seconds",1).put("script","Host: Synthetic fixture.\nGuest: Not a language lesson.");
        JSONObject show=new JSONObject().put("id","qa_share_show").put("title","Synthetic sharing QA").put("language","en").put("difficulty","basic").put("wish","PRIVATE_QA_INPUT").put("music_style","none").put("episodes",new JSONArray().put(ep));
        java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream();
        try(java.util.zip.ZipOutputStream zip=new java.util.zip.ZipOutputStream(output)){
            zip.putNextEntry(new java.util.zip.ZipEntry("shows.json"));zip.write(new JSONObject().put("shows",new JSONArray().put(show)).toString().getBytes(StandardCharsets.UTF_8));zip.closeEntry();
            zip.putNextEntry(new java.util.zip.ZipEntry("audio/qa_share_audio.wav"));zip.write(wav(880));zip.closeEntry();
        }
        String data=android.util.Base64.encodeToString(output.toByteArray(),android.util.Base64.NO_WRAP);
        String script="window.__sharingQA=null;(async()=>{const api=window.DIYFM;await api.ready;await api.importBackup(Uint8Array.from(atob("+JSONObject.quote(data)+"),c=>c.charCodeAt(0)).buffer);const list=async()=>(await(await api.fetch('/api/shows')).json()).shows;const original=(await list()).find(s=>s.title==='Synthetic sharing QA');const blob=await api.exportChannel(original.id,{author:'QA creator',source_url:'https://example.org/',license:'Synthetic fixture',episodeIds:original.episodes.map(e=>e.id)});const buffer=await blob.arrayBuffer();const before=(await list()).length;const preview=await api.prepareImport(buffer);if((await list()).length!==before)throw Error('Preview wrote data');const added=await api.commitImport(preview.token);const same=await api.prepareImport(buffer);if(!same.duplicate)throw Error('No deduplication');const again=await api.commitImport(same.token);if(again.showId!==added.showId)throw Error('Duplicate changed identity');const saved=(await list()).find(s=>s.id===added.showId);const audio=await(await fetch(saved.episodes[0].url)).blob();const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await audio.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('');window.__sharingQA={author:saved.provenance.author,hash:digest,channels:(await list()).length-before,script:preview.channels[0].episodes[0].script};})().catch(e=>window.__sharingQA={error:e.message});";
        main(()->{web.evaluateJavascript(script,null);return new JSONObject();});
        String raw="null";for(int i=0;i<150;i++){raw=readJS(web,"window.__sharingQA");if(!raw.equals("null"))break;Thread.sleep(100);}
        JSONObject result=new JSONObject(raw);assertFalse(result.toString(),result.has("error"));
        StringBuilder digest=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(wav(880)))digest.append(String.format(Locale.ROOT,"%02x",b&255));
        assertEquals(digest.toString(),result.getString("hash"));assertEquals("QA creator",result.getString("author"));assertEquals(1,result.getInt("channels"));assertTrue(result.getString("script").contains("Synthetic fixture"));
    }
    @Test public void listeningFirstNavigationPreservesDraftAndKeepsEpisodesAboveTheFold() throws Exception {
        java.lang.reflect.Field field=MainActivity.class.getDeclaredField("web");field.setAccessible(true);WebView web=(WebView)field.get(activity.getActivity());
        waitDocument(web);
        for(int i=0;i<100;i++){if(readJS(web,"!!window.DIYFM && !!document.querySelector('#ui-language')").equals("true"))break;Thread.sleep(100);}
        JSONObject show=new JSONObject().put("id","qa_layout_source").put("title","Late-night letters / 夜の手紙").put("language","en").put("difficulty","basic").put("wish","Original layout QA preference").put("music_style","none").put("episodes",new JSONArray()
            .put(new JSONObject().put("id","qa_layout_a").put("title","The elevator that stopped on every floor").put("status","ready").put("duration_seconds",1).put("script","Host: Layout QA, synthetic audio."))
            .put(new JSONObject().put("id","qa_layout_b").put("title","A message meant for someone else / 宛先ちがい").put("status","ready").put("duration_seconds",1).put("script","Guest: Test fixture, not a lesson.")));
        java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream();
        try(java.util.zip.ZipOutputStream zip=new java.util.zip.ZipOutputStream(output)){
            zip.putNextEntry(new java.util.zip.ZipEntry("shows.json"));zip.write(new JSONObject().put("shows",new JSONArray().put(show)).toString().getBytes(StandardCharsets.UTF_8));zip.closeEntry();
            for(String id:new String[]{"qa_layout_a","qa_layout_b"}){zip.putNextEntry(new java.util.zip.ZipEntry("audio/"+id+".wav"));zip.write(wav(880));zip.closeEntry();}
        }
        String data=android.util.Base64.encodeToString(output.toByteArray(),android.util.Base64.NO_WRAP);
        String script="window.__layoutQA='preparing-reload';(async()=>{await window.DIYFM.ready;await window.DIYFM.importBackup(Uint8Array.from(atob("+JSONObject.quote(data)+"),c=>c.charCodeAt(0)).buffer);location.reload();})().catch(e=>window.__layoutQA={error:e.message});";
        main(()->{web.evaluateJavascript(script,null);return new JSONObject();});
        boolean listed=false;
        for(int i=0;i<100;i++){if(readJS(web,"typeof window.__layoutQA==='undefined'&&[...document.querySelectorAll('#channel-switch option')].some(e=>e.textContent==='Late-night letters / 夜の手紙')").equals("true")){listed=true;break;}Thread.sleep(100);}
        assertTrue("Fixture not listed after reload",listed);
        String ui="window.__layoutQA=null;(async()=>{const $=id=>document.getElementById(id);const check=(ok,msg)=>{if(!ok)throw Error(msg)};const tick=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const fire=(id,value)=>{$(id).value=value;$(id).dispatchEvent(new Event('change',{bubbles:true}))};fire('ui-language','en');const pick=[...$('channel-switch').options].find(o=>o.textContent==='Late-night letters / \u591c\u306e\u624b\u7d19');fire('channel-switch',pick.value);await tick();check(!$('wish-form'),'Listening page is still a form');check(document.querySelectorAll('[data-play]').length===2,'Episodes missing');const play=document.querySelector('[data-play]').getBoundingClientRect(),nav=document.querySelector('.dock-nav').getBoundingClientRect();check(play.bottom<nav.top,'First Play action is below the fold');check(nav.top>innerHeight-90,'Navigation is not at the bottom');document.querySelector('[data-tab=compose]').click();check(!!document.querySelector('.series-locked'),'Locked setup missing');document.querySelector('.editor-tabs [data-tab=voice]').click();check(!!$('host'),'Sound controls missing');document.querySelector('[data-tab=listen]').click();check(!$('wish-form'),'Return did not reach episodes');$('new-channel').click();$('channel-title').value='Retained layout QA draft';fire('channel-title','Retained layout QA draft');document.querySelector('[name=series-theme][value=custom]').click();fire('custom-theme','Two friends mix up their lunch boxes.');check(!!document.querySelector('[data-key-settings]'),'Upfront key guidance missing');document.querySelector('[data-key-settings]').click();await tick();check(!$('settings-view').hidden,'Key link did not lead to settings');$('nav-studio').click();check($('channel-title').value==='Retained layout QA draft','Key detour lost title');check($('custom-theme').value==='Two friends mix up their lunch boxes.','Key detour lost theme');fire('channel-switch',pick.value);for(const lang of ['ja','zh-CN','en']){$('nav-settings').click();fire('ui-language',lang);$('nav-studio').click();check(!$('wish-form'),'Locale restored wrong page');check(document.documentElement.scrollWidth<=innerWidth+1,'Locale overflows');}window.__layoutQA={ok:true,width:innerWidth,height:innerHeight,playBottom:play.bottom,navTop:nav.top};})().catch(e=>window.__layoutQA={error:e.message});";
        main(()->{web.evaluateJavascript(ui,null);return new JSONObject();});
        String raw="null";for(int i=0;i<150;i++){raw=readJS(web,"window.__layoutQA");if(!raw.equals("null"))break;Thread.sleep(100);}
        JSONObject result=new JSONObject(raw);assertFalse(result.toString(),result.has("error"));assertTrue(result.toString(),result.getBoolean("ok"));
        android.util.Log.i("DIYFM_QA","Listening hierarchy and UI order: "+result);
        android.graphics.Bitmap shot=InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        java.io.File screenshot=new java.io.File(activity.getActivity().getExternalFilesDir(null),"listening-first-portrait.png");
        try(java.io.FileOutputStream file=new java.io.FileOutputStream(screenshot)){assertTrue(shot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,file));}finally{shot.recycle();}
        main(()->{web.evaluateJavascript("document.getElementById('new-channel').click()",null);return new JSONObject();});
    }
    // The signed test APK can seed/read only synthetic fixture data across an actual APK upgrade.
    // This exercises the public local-library API, not UI clicks or Google generation.
    void upgradeFixture(String phase) throws Exception {
        assertTrue(phase.equals("seed")||phase.equals("verify"));
        java.lang.reflect.Field field=MainActivity.class.getDeclaredField("web");field.setAccessible(true);WebView web=(WebView)field.get(activity.getActivity());
        String expectedVersion=InstrumentationRegistry.getArguments().getString("expectedVersion");
        waitDocument(web);
        for(int i=0;i<100;i++){String ready=readJS(web,"!!window.DIYFM_NATIVE && !!window.DIYFM");if(ready.equals("true"))break;Thread.sleep(100);}
        assertEquals(JSONObject.quote(expectedVersion),readJS(web,"window.DIYFM_NATIVE?.info.version"));
        byte[] audio=wav(880);
        StringBuilder expectedHash=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(audio))expectedHash.append(String.format(Locale.ROOT,"%02x",b&255));
        String seed="";
        if(phase.equals("seed")){
            JSONObject ep=new JSONObject().put("id","qa_upgrade_audio").put("title","Synthetic upgrade tone").put("status","ready").put("script","Synthetic tone, not model-generated speech.");
            JSONObject show=new JSONObject().put("id","qa_upgrade_show").put("title","Portrait upgrade QA").put("language","en").put("difficulty","basic").put("wish","Synthetic upgrade fixture").put("music_style","none").put("episodes",new JSONArray().put(ep));
            java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream();
            try(java.util.zip.ZipOutputStream zip=new java.util.zip.ZipOutputStream(output)){
                zip.putNextEntry(new java.util.zip.ZipEntry("shows.json"));zip.write(new JSONObject().put("shows",new JSONArray().put(show)).toString().getBytes(StandardCharsets.UTF_8));zip.closeEntry();
                zip.putNextEntry(new java.util.zip.ZipEntry("audio/qa_upgrade_audio.wav"));zip.write(audio);zip.closeEntry();
            }
            String data=android.util.Base64.encodeToString(output.toByteArray(),android.util.Base64.NO_WRAP);
            seed="await window.DIYFM.importBackup(Uint8Array.from(atob("+JSONObject.quote(data)+"),c=>c.charCodeAt(0)).buffer);await window.DIYFM.fetch('/api/settings',{method:'PUT',body:JSON.stringify({llm_model:'upgrade-qa-model'})});";
        }
        String countCheck=phase.equals("seed") ? "localStorage.setItem('diyfm-release-upgrade-count',String(shows.length));" : "if(Number(localStorage.getItem('diyfm-release-upgrade-count'))!==shows.length)throw Error('Library count changed across upgrade');";
        String script="window.__upgradeQA=null;(async()=>{await window.DIYFM.ready;"+seed+"const {shows}=await(await window.DIYFM.fetch('/api/shows')).json();const show=shows.find(s=>s.title==='Portrait upgrade QA');const ep=show?.episodes?.find(e=>e.status==='ready');if(!ep?.url)throw Error('Fixture missing');const bytes=await(await fetch(ep.url)).arrayBuffer();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');const config=await(await window.DIYFM.fetch('/api/settings')).json();"+countCheck+"window.__upgradeQA={hash,model:config.settings.llm_model,title:show.title,count:shows.length};})().catch(()=>window.__upgradeQA={error:'Fixture failed'});";
        main(()->{web.evaluateJavascript(script,null);return new JSONObject();});
        String raw="null";for(int i=0;i<100;i++){raw=readJS(web,"window.__upgradeQA");if(!raw.equals("null"))break;Thread.sleep(100);}
        JSONObject result=new JSONObject(raw);assertFalse(result.toString(),result.has("error"));
        assertEquals(expectedHash.toString(),result.getString("hash"));assertEquals("upgrade-qa-model",result.getString("model"));assertEquals("Portrait upgrade QA",result.getString("title"));assertTrue(result.getInt("count")>=1);
        android.util.Log.i("DIYFM_QA","Upgrade fixture "+phase+" passed on "+expectedVersion+": channel, model preference and WAV SHA-256 preserved.");
    }
    void waitDocument(WebView web) throws Exception {
        boolean ready=false;
        for(int i=0;i<150;i++){
            JSONObject navigation=main(()->new JSONObject().put("progress",web.getProgress()).put("url",String.valueOf(web.getUrl())));
            if(navigation.getInt("progress")==100 && navigation.getString("url").equals(MainActivity.ORIGIN+"/assets/web/index.html")){ready=true;break;}
            Thread.sleep(100);
        }
        assertTrue("Application document navigation did not complete",ready);
        // Runtime/DOM creation precedes app.js handlers and the initial library/settings render.
        boolean controlsReady=false;
        for(int i=0;i<100;i++){
            if(readJS(web,"!!document.getElementById('new-channel')?.onclick && !!document.getElementById('set-tts')?.value && !!document.querySelector('#play-featured, [data-play], #channel-title')").equals("true")){controlsReady=true;break;}
            Thread.sleep(100);
        }
        assertTrue("Application controls did not finish initialization",controlsReady);
    }
    @Test public void modelPresetsAndCustomIDsSaveReloadAndRestore() throws Exception {
        java.lang.reflect.Field field=MainActivity.class.getDeclaredField("web");field.setAccessible(true);WebView web=(WebView)field.get(activity.getActivity());
        waitDocument(web);
        String ui="window.__modelQA=null;(async()=>{const $=id=>document.getElementById(id);const check=(ok,msg)=>{if(!ok)throw Error(msg)};const wait=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw Error('Settings state timed out')};$('nav-settings').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const preset=$('set-tts-preset');check([...preset.options].some(o=>o.value==='gemini-3.8-flash-tts'),'Current TTS preset missing');check([...preset.options].some(o=>o.value==='gemini-3.8-flash-lite-tts'),'Lite TTS preset missing');preset.value='gemini-3.8-flash-lite-tts';preset.dispatchEvent(new Event('change',{bubbles:true}));check($('set-tts').value===preset.value,'Preset did not update editable ID');$('set-tts').value='custom-native-tts';$('set-tts').dispatchEvent(new Event('input',{bubbles:true}));check(preset.value==='','Custom ID did not select custom mode');$('save-settings').click();await wait(async()=>(await(await window.DIYFM.fetch('/api/settings')).json()).settings.tts_model==='custom-native-tts');location.reload();})().catch(e=>window.__modelQA={error:e.message});";
        main(()->{web.evaluateJavascript(ui,null);return new JSONObject();});
        boolean reloaded=false;
        for(int i=0;i<100;i++){
            if(readJS(web,"typeof window.__modelQA==='undefined'&&document.getElementById('set-tts')?.value==='custom-native-tts'").equals("true")){reloaded=true;break;}
            Thread.sleep(100);
        }
        assertTrue("Custom model ID did not survive reload",reloaded);
        String restore="window.__modelQA=null;(async()=>{document.getElementById('nav-settings').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));document.getElementById('restore-settings').click();for(let i=0;i<100;i++){const config=await(await window.DIYFM.fetch('/api/settings')).json();if(config.settings.tts_model==='gemini-3.8-flash-tts'&&document.getElementById('set-tts').value==='gemini-3.8-flash-tts'){window.__modelQA={ok:true};return;}await new Promise(r=>setTimeout(r,50));}throw Error('Defaults not restored')})().catch(e=>window.__modelQA={error:e.message});";
        main(()->{web.evaluateJavascript(restore,null);return new JSONObject();});
        String raw="null";for(int i=0;i<100;i++){raw=readJS(web,"window.__modelQA");if(!raw.equals("null"))break;Thread.sleep(100);}
        JSONObject result=new JSONObject(raw);assertFalse(result.toString(),result.has("error"));assertTrue(result.toString(),result.getBoolean("ok"));
    }
    @Test public void rawProviderErrorsRemainLiteralInMessagesAfterReloadAndLanguageSwitch() throws Exception {
        java.lang.reflect.Field field=MainActivity.class.getDeclaredField("web");field.setAccessible(true);WebView web=(WebView)field.get(activity.getActivity());
        waitDocument(web);
        String expected="HTTP 403 Forbidden\n"+new JSONObject().put("error",new JSONObject().put("code",403).put("status","PERMISSION_DENIED").put("message","Controlled QA: <script>must stay text</script>").put("details",new JSONArray().put(new JSONObject().put("reason","MODEL_ACCESS")))).toString(2);
        String seed="window.__rawQA='preparing';(async()=>{const reply=await window.DIYFM.fetch('/api/shows',{method:'POST',body:JSON.stringify({title:'Raw diagnostic QA',theme_id:'custom',wish:'Controlled diagnostics without model calls',description:'Synthetic error fixture',language:'en',difficulty:'basic',length:'BRIEF',host_voice:'Kore',guest_voice:'Puck',music_style:'none'})});const {show}=await reply.json();const {Library}=await import(new URL('./library.mjs',location.href).href);const lib=new Library();const shows=await lib.get('shows');shows.find(s=>s.id===show.id).episodes.push({id:'qa_raw_error_episode',title:'Controlled provider failure',status:'failed',phase:'voice',created_at:new Date().toISOString(),error:"+JSONObject.quote(expected)+"});await lib.write([['shows',shows]]);location.reload();})().catch(e=>window.__rawQA={error:e.message});";
        main(()->{web.evaluateJavascript(seed,null);return new JSONObject();});
        boolean reloaded=false;
        for(int i=0;i<150;i++){
            if(readJS(web,"typeof window.__rawQA==='undefined'&&!!document.querySelector('[data-task=qa_raw_error_episode]')").equals("true")){reloaded=true;break;}
            Thread.sleep(100);
        }
        assertTrue("Raw error fixture did not survive reload: "+readJS(web,"JSON.stringify({phase:window.__rawQA,url:location.href,rows:[...document.querySelectorAll('[data-task]')].map(e=>e.dataset.task)})"),reloaded);
        String verify="(()=>{const $=id=>document.getElementById(id);const check=()=>{const row=document.querySelector('[data-task=qa_raw_error_episode]').closest('li');if(row.querySelector('.inbox-error')?.textContent!=="+JSONObject.quote(expected)+")throw Error('Provider error was rewritten');if(row.querySelector('script'))throw Error('Provider HTML was interpreted')};try{$('inbox-btn').click();document.querySelector('[data-task=qa_raw_error_episode]').click();check();$('ui-language').value='zh-CN';$('ui-language').dispatchEvent(new Event('change',{bubbles:true}));check();return {ok:true}}catch(e){return {error:e.message}}finally{$('ui-language').value='en';$('ui-language').dispatchEvent(new Event('change',{bubbles:true}));}})()";
        JSONObject result=new JSONObject((String)new JSONTokener(readJS(web,"JSON.stringify("+verify+")")).nextValue());
        assertFalse(result.toString(),result.has("error"));assertTrue(result.toString(),result.getBoolean("ok"));
    }
    @Test public void customMusicKeywordsPersistDraftAndSavedSeriesLockWithoutModelCalls() throws Exception {
        java.lang.reflect.Field field=MainActivity.class.getDeclaredField("web");field.setAccessible(true);WebView web=(WebView)field.get(activity.getActivity());
        waitDocument(web);
        String seed="window.__musicQA=null;(async()=>{const $=id=>document.getElementById(id);const check=(ok,msg)=>{if(!ok)throw Error(msg)};const wait=async fn=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw Error('Music UI state timed out')};await window.DIYFM.ready;$('new-channel').click();await wait(()=>$('music'));$('music').value='custom';$('music').dispatchEvent(new Event('change',{bubbles:true}));$('music-keywords').value='';$('music-keywords').dispatchEvent(new Event('input',{bubbles:true}));check($('regenerate-music').disabled,'Empty custom keywords enabled generation');const words='悲伤、心碎、情侣争吵后的雨夜';$('music-keywords').value=words;$('music-keywords').dispatchEvent(new Event('input',{bubbles:true}));check(!$('regenerate-music').disabled,'Keywords did not enable generation');$('nav-settings').click();$('nav-studio').click();check($('music').value==='custom'&&$('music-keywords').value===words,'Draft lost custom keywords');const reply=await window.DIYFM.fetch('/api/shows',{method:'POST',body:JSON.stringify({title:'Custom music native QA',theme_id:'custom',wish:'Synthetic keyword test without model calls',language:'en',music_style:'custom',music_keywords:words})});const {show}=await reply.json();check(!!show?.id,'Custom series not saved');const patch=await window.DIYFM.fetch('/api/shows/'+show.id,{method:'PATCH',body:JSON.stringify({music_keywords:'epic'})});check(!patch.ok,'Saved series keywords were mutable');localStorage.setItem('diyfm-music-qa-show',show.id);location.reload();})().catch(e=>window.__musicQA={error:e.message});";
        main(()->{web.evaluateJavascript(seed,null);return new JSONObject();});
        boolean reloaded=false;
        for(int i=0;i<150;i++){if(readJS(web,"typeof window.__musicQA==='undefined'&&!!document.getElementById('new-channel')?.onclick").equals("true")){reloaded=true;break;}Thread.sleep(100);}
        assertTrue("Custom music fixture did not survive reload: "+readJS(web,"window.__musicQA"),reloaded);
        waitDocument(web);
        String verify="window.__musicQA=null;(async()=>{const $=id=>document.getElementById(id);const wait=async fn=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw Error('Saved music view timed out')};$('channel-switch').value=localStorage.getItem('diyfm-music-qa-show');$('channel-switch').dispatchEvent(new Event('change',{bubbles:true}));await wait(()=>document.querySelector('[data-tab=voice]'));document.querySelector('[data-tab=voice]').click();await wait(()=>$('music-keywords'));if($('music').value!=='custom'||!$('music').disabled||!$('music-keywords').readOnly||$('music-keywords').value!=='悲伤、心碎、情侣争吵后的雨夜')throw Error('Saved custom music not retained and locked');if(document.documentElement.scrollWidth>innerWidth+1)throw Error('Custom music overflows');$('new-channel').click();$('back-home').click();window.__musicQA={ok:true};})().catch(e=>window.__musicQA={error:e.message});";
        main(()->{web.evaluateJavascript(verify,null);return new JSONObject();});
        String raw="null";for(int i=0;i<150;i++){raw=readJS(web,"window.__musicQA");if(!raw.equals("null"))break;Thread.sleep(100);}
        JSONObject result=new JSONObject(raw);assertFalse(result.toString(),result.has("error"));assertTrue(result.toString(),result.getBoolean("ok"));
    }
    String readJS(WebView web,String expression) throws Exception {
        CountDownLatch gate=new CountDownLatch(1);AtomicReference<String> value=new AtomicReference<>("null");
        main(()->{web.evaluateJavascript(expression,v->{value.set(v);gate.countDown();});return new JSONObject();});
        assertTrue(gate.await(5,TimeUnit.SECONDS));return value.get();
    }
    JSONObject layout(WebView web) throws Exception {
        waitDocument(web);
        String result="";
        for(int i=0;i<80;i++){
            CountDownLatch gate=new CountDownLatch(1);AtomicReference<String> value=new AtomicReference<>("");
            main(()->{web.evaluateJavascript("JSON.stringify({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,button:document.querySelector('#make, #play-featured, [data-play]')?.getBoundingClientRect().height,header:document.querySelector('.dock')?.getBoundingClientRect().height,keyboard:document.documentElement.classList.contains('keyboard-open'),undersized:[...document.querySelectorAll('button,select')].filter(e=>e.getBoundingClientRect().height>0&&e.getBoundingClientRect().height<47.5).map(e=>e.id||e.className)})",v->{value.set(v);gate.countDown();});return new JSONObject();});
            assertTrue("WebView DOM callback timed out after document commit",gate.await(5,TimeUnit.SECONDS));result=value.get();if(result.contains("button"))break;Thread.sleep(100);
        }
        return new JSONObject((String)new JSONTokener(result).nextValue());
    }
    @Test public void portraitViewportAndTouchTargetsMatchTheDevice() throws Exception {
        java.lang.reflect.Field field=MainActivity.class.getDeclaredField("web");field.setAccessible(true);WebView web=(WebView)field.get(activity.getActivity());
        JSONObject metrics=layout(web);
        android.util.Log.i("DIYFM_QA","Portrait layout: "+metrics);
        assertTrue("Test requires portrait",metrics.getDouble("height")>metrics.getDouble("width"));
        assertTrue("Page overflows horizontally: "+metrics,metrics.getDouble("scroll")<=metrics.getDouble("width")+1);
        assertTrue("Primary touch target too small: "+metrics,metrics.getDouble("button")>=48);
        assertEquals("Some controls are too small: "+metrics,0,metrics.getJSONArray("undersized").length());
        assertTrue("Header consumes too much of the portrait screen: "+metrics,metrics.getDouble("header")<=140);
        float density=activity.getActivity().getResources().getDisplayMetrics().density;
        assertEquals("CSS viewport ignores native container width",web.getWidth()/density,metrics.getDouble("width"),2);
        assertEquals("CSS viewport ignores native container height",web.getHeight()/density,metrics.getDouble("height"),2);
        if(android.os.Build.VERSION.SDK_INT>=30){
            android.view.View content=(android.view.View)web.getParent();
            android.view.WindowInsets original=content.getRootWindowInsets();assertNotNull(original);
            android.view.WindowInsets keyboard=new android.view.WindowInsets.Builder(original).setInsets(android.view.WindowInsets.Type.ime(),android.graphics.Insets.of(0,0,0,(int)(280*density))).setVisible(android.view.WindowInsets.Type.ime(),true).build();
            MainActivity host=activity.getActivity();
            java.util.concurrent.atomic.AtomicInteger closedCallbacks=new java.util.concurrent.atomic.AtomicInteger();
            try {
                // Keep the controlled source installed through relayout. A one-shot dispatch can
                // be overwritten by the OS's real closed-IME state while this fixture is active.
                main(()->{
                    content.setOnApplyWindowInsetsListener((view,delivered)->{
                        if(!delivered.isVisible(android.view.WindowInsets.Type.ime()))closedCallbacks.incrementAndGet();
                        return host.applyContentInsets(view,keyboard);
                    });
                    content.dispatchApplyWindowInsets(keyboard);return new JSONObject();
                });
                JSONObject reduced=layout(web);
                for(int i=0;i<30&&(!reduced.getBoolean("keyboard")||reduced.getDouble("height")>=metrics.getDouble("height")-100);i++){Thread.sleep(100);reduced=layout(web);}
                assertTrue("IME does not reduce the actual viewport: "+reduced,reduced.getDouble("height")<metrics.getDouble("height")-100);
                assertTrue("IME compact mode not applied",reduced.getBoolean("keyboard"));
                assertTrue("Header expands during editing",reduced.getDouble("header")<=metrics.getDouble("header"));
                if(metrics.getDouble("header")>100)assertTrue("Channel switch consumes editing space",reduced.getDouble("header")<metrics.getDouble("header")-30);
                android.util.Log.i("DIYFM_QA","Controlled IME source: real closed-IME callbacks during relayout="+closedCallbacks.get());
            }finally{main(()->{content.setOnApplyWindowInsetsListener(host::applyContentInsets);content.dispatchApplyWindowInsets(original);return new JSONObject();});}
            JSONObject restored=layout(web);
            for(int i=0;i<30&&Math.abs(restored.getDouble("height")-metrics.getDouble("height"))>2;i++){Thread.sleep(100);restored=layout(web);}
            assertFalse("IME mode remains stuck",restored.getBoolean("keyboard"));
            assertEquals("Viewport did not recover after keyboard",metrics.getDouble("height"),restored.getDouble("height"),2);
        }
        try {
            main(()->{activity.getActivity().setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);return new JSONObject();});
            JSONObject landscape=layout(web);
            for(int i=0;i<40&&landscape.getDouble("width")<=landscape.getDouble("height");i++){Thread.sleep(100);landscape=layout(web);}
            assertTrue("Landscape transition did not reach WebView",landscape.getDouble("width")>landscape.getDouble("height"));
        }finally{main(()->{activity.getActivity().setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);return new JSONObject();});}
        JSONObject portrait=layout(web);
        for(int i=0;i<40&&Math.abs(portrait.getDouble("width")-metrics.getDouble("width"))>2;i++){Thread.sleep(100);portrait=layout(web);}
        assertEquals("Returning to portrait changes viewport width",metrics.getDouble("width"),portrait.getDouble("width"),2);
        assertTrue("Rotation leaves horizontal overflow",portrait.getDouble("scroll")<=portrait.getDouble("width")+1);
    }
}
