package io.github.jaysonsheyue.diyfm;

import android.content.Context;
import android.net.Uri;
import org.json.JSONObject;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;

final class NativeFiles {
    static final long LIMIT = 500L * 1024 * 1024;
    final Context context;
    final File media, staging;
    final Map<String, Upload> uploads = new HashMap<>();
    record Upload(File file, long size, String key, Uri destination) {}
    NativeFiles(Context context) {
        this.context=context;
        media=new File(context.getFilesDir(),"audio-cache"); staging=new File(context.getCacheDir(),"transfers");
        media.mkdirs(); staging.mkdirs();
        File[] leftovers=staging.listFiles(); if(leftovers!=null) for(File f:leftovers) f.delete();
    }
    static String key(String value) {
        if(!value.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid media key");
        return value;
    }
    File audio(String value) {return new File(media,key(value)+".wav");}
    JSONObject begin(JSONObject data, Uri destination) throws Exception {
        long size=data.getLong("size"); if(size<1 || size>LIMIT) throw new IOException("File limit");
        String id=data.optString("kind").equals("media") ? key(data.getString("id")) : null;
        if(id!=null && audio(id).isFile() && audio(id).length()==size) return new JSONObject().put("exists",true);
        if(id==null && destination==null) throw new IOException("No destination");
        String ticket=UUID.randomUUID().toString(); File file=new File(staging,ticket+".part");
        if(!file.createNewFile()) throw new IOException("Transfer unavailable");
        uploads.put(ticket,new Upload(file,size,id,destination));
        return new JSONObject().put("ticket",ticket);
    }
    Upload upload(String ticket) throws IOException {Upload u=uploads.get(ticket); if(u==null)throw new IOException("Transfer missing");return u;}
    JSONObject chunk(JSONObject data) throws Exception {
        Upload u=upload(data.getString("ticket"));
        if(data.getString("data").length()>300000)throw new IOException("Chunk limit");
        byte[] bytes=android.util.Base64.decode(data.getString("data"),android.util.Base64.NO_WRAP);
        if(bytes.length>192*1024 || data.getLong("offset")!=u.file.length() || u.file.length()+bytes.length>u.size)throw new IOException("Transfer sequence");
        try(FileOutputStream out=new FileOutputStream(u.file,true)){out.write(bytes);}
        return new JSONObject().put("written",u.file.length());
    }
    JSONObject commit(String ticket) throws Exception {
        Upload u=upload(ticket); if(u.file.length()!=u.size)throw new IOException("Incomplete transfer");
        if(u.key!=null) {
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            try(InputStream in=new FileInputStream(u.file)){byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)digest.update(b,0,n);}
            StringBuilder actual=new StringBuilder(); for(byte b:digest.digest())actual.append(String.format(Locale.ROOT,"%02x",b&255));
            if(!actual.toString().equals(u.key))throw new IOException("Hash mismatch");
            try(RandomAccessFile f=new RandomAccessFile(u.file,"r")){if(f.readInt()!=0x52494646 || f.skipBytes(4)!=4 || f.readInt()!=0x57415645)throw new IOException("Not WAV");}
            File target=audio(u.key);
            if(target.exists())u.file.delete(); else if(!u.file.renameTo(target))throw new IOException("Cannot save media");
        } else {
            try(InputStream in=new FileInputStream(u.file); OutputStream out=context.getContentResolver().openOutputStream(u.destination,"wt")) {
                if(out==null)throw new IOException("Cannot open destination");
                byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)out.write(b,0,n);out.flush();
            }
            u.file.delete();
        }
        uploads.remove(ticket);return new JSONObject().put("saved",true);
    }
    JSONObject abort(String ticket){Upload u=uploads.remove(ticket);if(u!=null)u.file.delete();return new JSONObject();}
    void prune(Set<String> keep) {File[] files=media.listFiles();if(files!=null)for(File f:files)if(!keep.contains(f.getName().replace(".wav","")))f.delete();}
}
