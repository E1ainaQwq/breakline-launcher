package cn.delta.bootstrap;

import net.minecraftforge.fml.earlydisplay.RenderElement;
import net.minecraftforge.fml.earlydisplay.RenderElement.DisplayContext;
import static org.lwjgl.opengl.GL33C.*;
import java.awt.*;
import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;

/** Drawn by Forge's existing render thread into its existing early framebuffer. */
public final class DeltaEarlyArt {
    private int program,vao,texture;
    private int renderedFrames;
    private final long started=System.nanoTime();
    // Forge's callback interfaces are package-private. Adapt them without adding
    // a split package to the ModLauncher service layer; keep its element lifecycle.
    public RenderElement element(){
        try {
            var type=Class.forName("net.minecraftforge.fml.earlydisplay.RenderElement$Initializer");
            var rendererType=Class.forName("net.minecraftforge.fml.earlydisplay.RenderElement$Renderer");
            var renderer=java.lang.reflect.Proxy.newProxyInstance(rendererType.getClassLoader(),new Class<?>[]{rendererType},
                (proxy,method,args)->{if(method.getName().equals("accept"))render((DisplayContext)args[1],(int)args[2]);return null;});
            var initializer=java.lang.reflect.Proxy.newProxyInstance(type.getClassLoader(),new Class<?>[]{type},
                (proxy,method,args)->renderer);
            return RenderElement.class.getConstructor(type).newInstance(initializer);
        }catch(ReflectiveOperationException error){throw new IllegalStateException("Unsupported Forge early renderer",error);}
    }
    private static int shader(int type,String source){
        int shader=glCreateShader(type);glShaderSource(shader,source);glCompileShader(shader);
        if(glGetShaderi(shader,GL_COMPILE_STATUS)==0)throw new IllegalStateException(glGetShaderInfoLog(shader));
        return shader;
    }
    private void init(){
        program=glCreateProgram();
        int vertex=shader(GL_VERTEX_SHADER,"#version 150\nout vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,0,1);}");
        int fragment=shader(GL_FRAGMENT_SHADER,"""
            #version 150
            in vec2 uv;out vec4 color;uniform sampler2D art;uniform vec2 size;uniform float time;
            void main(){
                float a=size.x/size.y;vec2 crop=vec2(min(1.,a/(16./9.)),min(1.,(16./9.)/a));
                // Forge EarlyFramebuffer.draw flips the source Y range on presentation.
                // Keep the uploaded top-down artwork here; do not flip it twice.
                vec2 p=(uv-.5)*crop+.5;color=texture(art,p);
                vec2 ring=(uv*size-vec2(size.x-36.,size.y-32.));float r=length(ring);
                if(r>7.&&r<9.){float angle=atan(ring.y,ring.x)+time*3.;float v=.35+.65*(sin(angle)*.5+.5);color=vec4(vec3(.65,.9,.85)*v,1);}
            }
            """);
        glAttachShader(program,vertex);glAttachShader(program,fragment);glLinkProgram(program);
        glDeleteShader(vertex);glDeleteShader(fragment);
        if(glGetProgrami(program,GL_LINK_STATUS)==0)throw new IllegalStateException(glGetProgramInfoLog(program));
        vao=glGenVertexArrays();texture=glGenTextures();
        try(var stream=getClass().getResourceAsStream("/delta-loading.png")){
            if(stream==null)throw new IllegalStateException("Missing loading artwork");
            BufferedImage source=ImageIO.read(stream),canvas=new BufferedImage(1920,1080,BufferedImage.TYPE_INT_ARGB);
            var g=canvas.createGraphics();
            g.drawImage(source,0,0,1920,1080,null);g.setColor(new Color(5,15,22,75));g.fillRect(0,0,1920,1080);
            g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING,RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
            g.setColor(new Color(235,245,242));g.setFont(new Font("Microsoft YaHei",Font.BOLD,48));g.drawString("断界行动",52,90);
            g.setFont(new Font("Microsoft YaHei",Font.PLAIN,25));g.drawString("正在启动",1640,1020);g.dispose();
            var bytes=org.lwjgl.BufferUtils.createByteBuffer(1920*1080*4);
            for(int y=0;y<1080;y++)for(int x=0;x<1920;x++){int argb=canvas.getRGB(x,y);bytes.put((byte)(argb>>16)).put((byte)(argb>>8)).put((byte)argb).put((byte)255);}bytes.flip();
            glBindTexture(GL_TEXTURE_2D,texture);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_LINEAR);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_LINEAR);
            glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,1920,1080,0,GL_RGBA,GL_UNSIGNED_BYTE,bytes);
        }catch(java.io.IOException error){throw new IllegalStateException(error);}
    }
    public void render(DisplayContext context,int frame){
        int oldProgram=glGetInteger(GL_CURRENT_PROGRAM),oldVao=glGetInteger(GL_VERTEX_ARRAY_BINDING),active=glGetInteger(GL_ACTIVE_TEXTURE);
        glActiveTexture(GL_TEXTURE0);int oldTexture=glGetInteger(GL_TEXTURE_BINDING_2D);
        boolean depth=glIsEnabled(GL_DEPTH_TEST),blend=glIsEnabled(GL_BLEND);
        try {
            if(program==0)init();
            glDisable(GL_DEPTH_TEST);glDisable(GL_BLEND);glUseProgram(program);glBindVertexArray(vao);glBindTexture(GL_TEXTURE_2D,texture);
            glUniform1i(glGetUniformLocation(program,"art"),0);glUniform2f(glGetUniformLocation(program,"size"),context.scaledWidth(),context.scaledHeight());
            glUniform1f(glGetUniformLocation(program,"time"),(System.nanoTime()-started)/1_000_000_000f);
            glDrawArrays(GL_TRIANGLES,0,3);
            if(++renderedFrames==2){
                captureDiagnosticFramebuffer();
                System.out.println("[delta-bootstrap] branded early loading rendered");
            }
        }finally{
            glBindTexture(GL_TEXTURE_2D,oldTexture);glActiveTexture(active);glBindVertexArray(oldVao);glUseProgram(oldProgram);
            if(depth)glEnable(GL_DEPTH_TEST);if(blend)glEnable(GL_BLEND);
        }
    }
    // This is the intermediate framebuffer, before Forge's flipped presentation.
    // Verify orientation from the OS window capture, not this diagnostic image.
    private static void captureDiagnosticFramebuffer(){
        String path=System.getProperty("delta.early.capture");
        if(path==null||path.isBlank())return;
        int[] viewport=new int[4];glGetIntegerv(GL_VIEWPORT,viewport);
        int width=viewport[2],height=viewport[3];
        var pixels=org.lwjgl.BufferUtils.createByteBuffer(width*height*4);
        glReadPixels(viewport[0],viewport[1],width,height,GL_RGBA,GL_UNSIGNED_BYTE,pixels);
        var image=new BufferedImage(width,height,BufferedImage.TYPE_INT_ARGB);
        for(int y=0;y<height;y++)for(int x=0;x<width;x++){
            int i=(y*width+x)*4;
            image.setRGB(x,height-y-1,0xff000000|((pixels.get(i)&255)<<16)|((pixels.get(i+1)&255)<<8)|(pixels.get(i+2)&255));
        }
        try{ImageIO.write(image,"png",new java.io.File(path));}
        catch(java.io.IOException error){throw new IllegalStateException("Cannot capture loading diagnostic",error);}
    }
}
