using Newtonsoft.Json;

var sample = new
{
    template = "dotnet-linux",
    targetFramework = "net10.0",
    runtime = Environment.Version.ToString(),
    package = typeof(JsonConvert).Assembly.GetName().Version?.ToString()
};

Console.WriteLine(JsonConvert.SerializeObject(sample));
